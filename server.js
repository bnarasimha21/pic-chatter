const express = require('express');
const path = require('path');
require('dotenv').config();
const multer = require('multer');
const sharp = require('sharp');

const vision = require('./lib/vision');
const storage = require('./lib/storage');
const { createTimer } = require('./lib/timing');
const { downscaleIfNeeded } = require('./lib/imagePrep');
const { checkFrame } = require('./lib/frameCheck');
const { isValidAnswer, fallbackAnswer } = require('./lib/answerSchema');
const { truncateAtSentence } = require('./lib/textUtils');
const { computeCost } = require('./lib/cost');
const { createPerIpLimiter, createDailyCap } = require('./lib/rateLimit');
const { logAskRequest } = require('./lib/logger');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024);
const MAX_QUESTION_LENGTH = Number(process.env.MAX_QUESTION_LENGTH || 300);
const MAX_ANSWER_LENGTH = Number(process.env.MAX_ANSWER_LENGTH || 400);
const ALLOWED_MIME = /^image\/(jpeg|png|webp)$/;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

class ValidationError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Wraps an async route handler so a rejected promise reaches the error
// middleware instead of crashing the process or hanging the request.
function asyncHandler(fn) {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

app.get('/', (req, res) => {
  res.render('index', {
    visionProvider: vision.resolveProviderName()
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', provider: vision.resolveProviderName() });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return cb(new ValidationError('Unsupported image type', 415));
    }
    cb(null, true);
  }
});

app.post(
  '/ask',
  createPerIpLimiter(),
  createDailyCap(),
  upload.single('image'),
  asyncHandler(async (req, res) => {
    const timer = createTimer();
    timer.mark('received');

    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const question = (req.body.question || '').toString().trim();
    if (question.length === 0) {
      return res.status(400).json({ error: 'A question is required' });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ error: `Question is too long (max ${MAX_QUESTION_LENGTH} characters)` });
    }

    // The declared Content-Type can lie (a text file renamed to .jpg); the
    // real format comes from sniffing the bytes.
    let metadata;
    try {
      metadata = await sharp(req.file.buffer).metadata();
    } catch (err) {
      return res.status(415).json({ error: 'Could not read the uploaded file as an image' });
    }
    if (!ALLOWED_FORMATS.has(metadata.format)) {
      return res.status(415).json({ error: 'Unsupported image type' });
    }

    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const frame = await checkFrame(req.file.buffer);
    timer.mark('preprocess_done');

    let finalAnswer;
    let model = null;
    let usage = null;
    let providerName = 'none';
    let status = 200;
    let schemaValid = true;

    if (!frame.usable) {
      finalAnswer = fallbackAnswer(frame.reason);
      finalAnswer.answer = frame.reason === 'too_dark'
        ? "I can't see anything in this picture. Try pointing the camera somewhere brighter."
        : "This picture looks too plain or blurry to say anything useful about. Try a clearer shot.";
      schemaValid = false;
      timer.mark('provider_first_byte');
      timer.mark('provider_done');
    } else {
      const prep = await downscaleIfNeeded(req.file.buffer, req.file.mimetype);

      let visionResult;
      try {
        const [result] = await Promise.all([
          vision.describe({ imageBytes: prep.buffer, mime: prep.mime, question, signal: controller.signal }),
          storage.maybeStore({ buffer: prep.buffer, mime: prep.mime }).catch(() => null)
        ]);
        visionResult = result;
      } catch (err) {
        if (err.name === 'AbortError') {
          // The client disconnected; there is nobody to answer.
          return;
        }
        timer.mark('provider_first_byte');
        timer.mark('provider_done');
        status = 502;
        logAskRequest({ sizeBytes: req.file.size, mime: req.file.mimetype, durationMs: timer.mark('response_sent'), status, provider: vision.resolveProviderName() });
        return res.status(502).json({ error: 'The vision provider failed to answer. Please try again.' });
      }

      timer.mark('provider_first_byte');
      timer.mark('provider_done');

      providerName = visionResult.providerName;
      model = visionResult.model;
      usage = visionResult.usage;

      if (visionResult.invalid || !isValidAnswer(visionResult.answer)) {
        console.warn(`[ask] provider reply did not validate: reason=${visionResult.reason || 'schema_invalid'}`);
        finalAnswer = fallbackAnswer(visionResult.reason || 'schema_invalid');
        schemaValid = false;
      } else {
        finalAnswer = { ...visionResult.answer };
      }
    }

    finalAnswer.answer = truncateAtSentence(finalAnswer.answer, MAX_ANSWER_LENGTH);

    const cost = model ? computeCost(model, usage) : null;

    // Mark response_sent before building the payload so the body's timing
    // object actually includes it, not just the Server-Timing header.
    timer.mark('response_sent');
    const payload = {
      answer: finalAnswer,
      model,
      usage: usage ? { ...usage, cost } : null,
      timing: timer.toJSON(),
      schemaValid
    };

    res.set('Server-Timing', timer.toServerTimingHeader());
    logAskRequest({
      sizeBytes: req.file.size,
      mime: req.file.mimetype,
      durationMs: timer.toJSON().response_sent,
      status,
      provider: providerName
    });
    res.json(payload);
  })
);

// Central error handler. Validation errors, multer errors, and anything
// else that reaches here is turned into JSON; nothing crashes the process.
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `Image is too large (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB maximum)` : `Upload error: ${err.message}`
    });
  }
  if (res.headersSent) return next(err);
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

let server = null;

if (require.main === module) {
  try {
    vision.assertConfigured();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT} (VISION_PROVIDER=${vision.resolveProviderName()})`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} signal received: closing HTTP server`);
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app };
