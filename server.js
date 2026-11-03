const express = require('express');
const path = require('path');
require('dotenv').config();
const multer = require('multer');
const sharp = require('sharp');

const vision = require('./lib/vision');
const storage = require('./lib/storage');
const consent = require('./public/js/consent');
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
    visionProvider: vision.resolveProviderName(),
    storeImages: storage.isEnabled(),
    retentionMinutes: storage.getRetentionMinutes()
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

const perIpLimiter = createPerIpLimiter();

// Attaches the abort controller and wires it to the response's 'close'
// event as the very first thing in the middleware chain, before multer
// (or anything else) has a chance to await. By the time an async route
// handler runs, multer has already fully buffered the multipart body, so
// the request stream has already ended; attaching a 'close' listener to
// `req` at that point attaches after the event may already have fired and
// it never fires again. `res.on('close')` is the event Node/Express
// actually documents for "the underlying connection was terminated before
// the response completed" (https://nodejs.org/api/http.html#event-close_1),
// and it fires on a real client disconnect regardless of how much of the
// request body has already been read, so it is attached here, first.
function attachAbortController(req, res, next) {
  const controller = new AbortController();
  req.visionAbortController = controller;
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  next();
}

app.post(
  '/ask',
  attachAbortController,
  perIpLimiter,
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

    // Server-side consent check (issue 2/4): a client-side localStorage flag
    // only gates the browser's own UI. A direct POST to /ask (curl, a
    // script, a replayed request) never touches that UI, so without this
    // check it would bypass consent entirely whenever storage is on.
    //
    // A bare "true" is not enough on its own: the client's consent notice
    // was built from a fingerprint of the server's config (provider,
    // whether storage is on, retention minutes) at the moment it was
    // accepted. A browser tab left open from before an operator switches
    // storage on, or swaps provider, still has consent=true in its own
    // stale closure, and would otherwise keep bypassing a notice it never
    // actually saw. Recomputing the server's own current fingerprint here
    // and requiring an exact match closes that gap; a mismatch is treated
    // the same as no consent at all, never as a partial/weaker consent.
    const consentBooleanGiven = (req.body.consent || '').toString().trim() === 'true';
    const expectedConsentFingerprint = consent.buildFingerprint({
      provider: vision.resolveProviderName(),
      storeImages: storage.isEnabled(),
      retentionMinutes: storage.getRetentionMinutes()
    });
    const consentGiven = consentBooleanGiven && (req.body.consentFingerprint || '') === expectedConsentFingerprint;

    // The declared Content-Type can lie (a text file renamed to .jpg); the
    // real format comes from sniffing the bytes. This detected format, not
    // the client-declared mime, is what gets sent on to the vision provider
    // below, since a mismatched declared type (e.g. a real JPEG posted as
    // image/png) would otherwise reach Anthropic mislabeled and be rejected.
    let metadata;
    try {
      metadata = await sharp(req.file.buffer).metadata();
    } catch (err) {
      return res.status(415).json({ error: 'Could not read the uploaded file as an image' });
    }
    if (!ALLOWED_FORMATS.has(metadata.format)) {
      return res.status(415).json({ error: 'Unsupported image type' });
    }
    const detectedMime = `image/${metadata.format}`;

    const controller = req.visionAbortController;

    const frame = await checkFrame(req.file.buffer);
    timer.mark('preprocess_done');

    let finalAnswer;
    let model = null;
    let usage = null;
    let providerName = 'none';
    let status = 200;
    let schemaValid = true;
    let storedImage = null;

    if (!frame.usable) {
      finalAnswer = fallbackAnswer(frame.reason);
      finalAnswer.answer = frame.reason === 'too_dark'
        ? "I can't see anything in this picture. Try pointing the camera somewhere brighter."
        : frame.reason === 'too_large'
          ? 'This picture is too large to process. Try a smaller image.'
          : "This picture looks too plain or blurry to say anything useful about. Try a clearer shot.";
      schemaValid = false;
      timer.mark('provider_first_byte');
      timer.mark('provider_done');
    } else {
      const prep = await downscaleIfNeeded(req.file.buffer, detectedMime);

      let visionResult;
      try {
        visionResult = await vision.describe({ imageBytes: prep.buffer, mime: prep.mime, question, signal: controller.signal });
      } catch (err) {
        // Checking the signal itself, rather than matching the error's
        // name/type, is what makes this work for every provider: the fake
        // provider throws an error named "AbortError", but the real
        // Anthropic SDK rejects with its own APIUserAbortError, which has a
        // different name and does not satisfy `err.name === 'AbortError'`.
        // Both cases are only reachable by the signal actually having
        // fired, so that is the one condition this checks.
        if (controller.signal.aborted) {
          // The client disconnected; there is nobody to answer.
          return;
        }
        timer.mark('provider_first_byte');
        timer.mark('provider_done');
        status = 502;
        logAskRequest({ sizeBytes: req.file.size, mime: detectedMime, durationMs: timer.mark('response_sent'), status, provider: vision.resolveProviderName() });
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

      // Storage only runs after a successful, completed, schema-valid
      // vision call (issue 2/3): not in parallel with the vision call,
      // which previously uploaded a photo even when the call failed or the
      // client had already disconnected. It also requires the `consent`
      // field sent with this exact request, so a direct API POST that
      // skips the browser's consent UI entirely no longer gets stored.
      if (schemaValid && consentGiven && storage.isEnabled() && !controller.signal.aborted) {
        try {
          const stored = await storage.maybeStore({ buffer: prep.buffer, mime: prep.mime, signal: controller.signal });
          if (stored) {
            storedImage = { url: stored.url, expiresAt: stored.expiresAt };
          }
        } catch (err) {
          // Never let a storage failure fail the user's request, but do
          // not swallow it silently either (the pre-fix code did, via a
          // bare `.catch(() => null)`). No image bytes or question text in
          // this log line, consistent with lib/logger.js's rule.
          console.warn(`[ask] storage failed for a captured image: ${err.message}`);
        }
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
      schemaValid,
      storedImage
    };

    res.set('Server-Timing', timer.toServerTimingHeader());
    logAskRequest({
      sizeBytes: req.file.size,
      mime: detectedMime,
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

  // Self-heal on restart (issue 2): if the process crashed, was redeployed,
  // or was simply restarted while a stored photo was still inside its
  // retention window, nothing before this would ever delete it, because
  // the only thing driving deletion was an in-memory timer that dies with
  // the process. This sweep runs once at startup and deletes anything
  // already older than the retention window. It is fire-and-forget: a
  // failure here must not block the server from starting.
  if (storage.isEnabled()) {
    storage.sweepExpiredOnStartup().catch((err) => {
      console.warn('Startup storage sweep failed:', err.message);
    });
    storage.ensureLifecyclePolicy().catch((err) => {
      console.warn('Could not set a bucket lifecycle backstop (this is a best-effort extra, not the primary deletion path):', err.message);
    });
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

module.exports = { app, perIpLimiter };
