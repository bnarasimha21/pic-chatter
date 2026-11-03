'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.VISION_PROVIDER = 'fake';
process.env.RATE_LIMIT_PER_WINDOW = '1000';
process.env.DAILY_CALL_CAP = '1000';

const { startApp } = require('./helpers/app');
const fakeVision = require('../lib/vision/fake');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function imageForm(filePath, question, fieldName = 'image', mimeType = 'image/jpeg') {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append(fieldName, new Blob([bytes], { type: mimeType }), path.basename(filePath));
  if (question !== undefined) form.append('question', question);
  return form;
}

test('issue 1: POST /ask', async (t) => {
  const app = startApp();
  t.after(() => app.close());

  await t.test('without an image returns 400', async () => {
    const form = new FormData();
    form.append('question', 'what is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /image/i);
  });

  await t.test('with a 20 MB body returns 413', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const form = new FormData();
    form.append('image', new Blob([big], { type: 'image/jpeg' }), 'huge.jpg');
    form.append('question', 'what is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 413);
  });

  await t.test('with a text file renamed to .jpg returns 415', async () => {
    const form = imageForm(path.join(FIXTURE_DIR, 'not-an-image.jpg'), 'what is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 415);
  });

  await t.test('a real fixture image returns the expected JSON shape and the fake provider sees the exact bytes', async () => {
    fakeVision.reset();
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'sample.jpg'));
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what color is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.answer && typeof body.answer.answer === 'string');
    assert.equal(body.model, fakeVision.FAKE_MODEL);
    assert.ok(body.usage && typeof body.usage.inputTokens === 'number');
    assert.ok(body.timing && typeof body.timing.received === 'number');

    const lastRequest = fakeVision.getLastRequest();
    assert.ok(lastRequest, 'fake provider should have recorded a request');
    // Images are downscaled before reaching the provider; the sample fixture
    // is already under the cap, so the provider should see those same bytes.
    assert.equal(lastRequest.imageBytes.length, bytes.length);
    assert.equal(Buffer.compare(lastRequest.imageBytes, bytes), 0);
    assert.equal(lastRequest.question, 'what color is this?');
  });

  await t.test('a provider error returns 502 JSON', async () => {
    fakeVision.reset();
    fakeVision.setNextReply({ type: 'error', message: 'simulated outage' });
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /provider/i);
  });

  await t.test('issue review fix: a client disconnecting mid-call actually aborts the in-flight vision call', async () => {
    // The pre-fix code attached its abort listener to req.on('close') after
    // an await, by which point multer had already fully buffered the
    // upload; a disconnect after that point was never observed, so the
    // vision call ran (and billed) to completion regardless. A long
    // artificial delay here keeps the fake provider's call in flight long
    // enough to prove the abort actually reaches it, not just that the
    // client-side fetch rejects.
    fakeVision.reset();
    fakeVision.setDelayMs(500);

    const controller = new AbortController();
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what is this?');

    const fetchPromise = fetch(`${app.baseUrl}/ask`, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });

    // Give the request time to reach the server and start the (500ms)
    // vision call, then disconnect before it would otherwise finish.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    await assert.rejects(fetchPromise);

    // Wait past the delay window so the fake provider's call would have
    // completed by now if the abort had not actually reached it.
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(fakeVision.getAbortCount(), 1, 'the fake provider should have observed exactly one aborted call');
    assert.equal(fakeVision.getCallCount(), 0, 'an aborted call must never count as a completed one');

    fakeVision.setDelayMs(0);
  });

  await t.test('issue review fix: a real JPEG declared as image/png by the browser still reaches the provider correctly labelled', async () => {
    // The browser's declared Content-Type can be wrong (e.g. a stale blob
    // mime type) even when the bytes decode fine. The pre-fix code passed
    // req.file.mimetype straight through to the provider whenever no
    // resize happened, so a real JPEG declared as image/png would reach
    // Anthropic mislabeled and get rejected. The fix detects the real
    // format from the bytes via sharp and uses that instead.
    fakeVision.reset();
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what is this?', 'image', 'image/png');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 200, 'a real image should not be rejected just because the declared mime was wrong');

    const lastRequest = fakeVision.getLastRequest();
    assert.equal(lastRequest.mime, 'image/jpeg', 'the provider must see the detected format, not the client-declared one');
  });
});
