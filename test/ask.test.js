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
});
