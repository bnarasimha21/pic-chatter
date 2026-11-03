'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.VISION_PROVIDER = 'fake';
process.env.STORE_IMAGES = 'false';
process.env.RATE_LIMIT_PER_WINDOW = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.DAILY_CALL_CAP = '1000';

const { startApp } = require('./helpers/app');
const storage = require('../lib/storage');

const SAMPLE = path.join(__dirname, 'fixtures', 'sample.jpg');

function imageForm(question) {
  const form = new FormData();
  const bytes = fs.readFileSync(SAMPLE);
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'sample.jpg');
  form.append('question', question);
  return form;
}

test('issue 2: rate limiting and log scrubbing', async (t) => {
  const app = startApp();
  t.after(() => app.close());

  await t.test('a request over the per-IP limit gets 429 with Retry-After', async () => {
    const r1 = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('q1') });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('q2') });
    assert.equal(r2.status, 200);
    const r3 = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('q3') });
    assert.equal(r3.status, 429);
    assert.ok(r3.headers.get('retry-after') !== null);
  });

  await t.test('STORE_IMAGES=false means /ask never calls S3', async () => {
    // The previous test deliberately drove the per-IP limiter to its cap
    // of 2 (RATE_LIMIT_PER_WINDOW above), so without resetting it here this
    // request would get a 429 before ever reaching the route handler and
    // this test would pass without exercising the storage path at all.
    // Resetting the shared limiter's state isolates this test from that
    // one, same as a different IP or key would, without needing either.
    app.perIpLimiter.__reset();
    storage.__resetForTests();
    const fakeClient = { calls: [], async send(cmd) { this.calls.push(cmd); return {}; } };
    storage.__setClientForTests(fakeClient);

    const form = imageForm('does this touch storage?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    assert.equal(storage.__getCallCount(), 0);
    assert.equal(fakeClient.calls.length, 0);
  });

  await t.test('request logs contain no image bytes and no question text', async () => {
    // Same isolation concern as above: without this, the per-IP limiter is
    // already at its cap from the prior sub-tests and the request below
    // would get a 429 without the route handler (and its logging) ever
    // running, so this test would pass without checking anything real.
    app.perIpLimiter.__reset();

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    let res;
    try {
      const secretQuestion = 'super-secret-question-xyz';
      res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm(secretQuestion) });
    } finally {
      console.log = originalLog;
    }
    assert.equal(res.status, 200, 'the request must actually succeed for this check to mean anything');
    const joined = lines.join('\n');
    assert.ok(!joined.includes('super-secret-question-xyz'), 'question text must not be logged');
    // A crude but effective check that raw binary image data never made it
    // into a log line: JPEG bytes start with the SOI marker 0xFFD8, which
    // cannot be represented as printable ASCII/UTF-8 text in a log line.
    assert.ok(!/\xFF\xD8/.test(joined));
    // The raw-bytes check above would not catch a leak that base64-encodes
    // the image first, so also check for a real fragment of the actual
    // test image's base64 encoding, long enough that it could not appear
    // by coincidence in an unrelated log line.
    const sampleBytes = fs.readFileSync(SAMPLE);
    const base64Fragment = sampleBytes.toString('base64').slice(0, 64);
    assert.ok(!joined.includes(base64Fragment), 'base64-encoded image bytes must not be logged');
  });
});
