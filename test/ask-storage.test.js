'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.VISION_PROVIDER = 'fake';
process.env.RATE_LIMIT_PER_WINDOW = '1000';
process.env.DAILY_CALL_CAP = '1000';
process.env.STORE_IMAGES = 'true';
process.env.STORE_RETENTION_MINUTES = '10';
process.env.SPACES_ENDPOINT = 'fake.example.com';
process.env.SPACES_BUCKET = 'fake-bucket';
process.env.SPACES_KEY = 'fake-key';
process.env.SPACES_SECRET = 'fake-secret';

const { startApp } = require('./helpers/app');
const fakeVision = require('../lib/vision/fake');
const storage = require('../lib/storage');
const consent = require('../public/js/consent');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// The fingerprint the server will expect, given this test file's own env
// (VISION_PROVIDER=fake, STORE_IMAGES=true, STORE_RETENTION_MINUTES=10 set
// above). Computed the same way the server computes its own, so these
// tests exercise the real matching logic rather than a hand-rolled guess
// at the expected string.
const VALID_CONSENT_FINGERPRINT = consent.buildFingerprint({
  provider: 'fake',
  storeImages: true,
  retentionMinutes: 10
});

function makeFakeS3Client() {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return {};
    }
  };
}

function imageForm(question, consentValue, consentFingerprint) {
  const form = new FormData();
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'sample.jpg'));
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'sample.jpg');
  form.append('question', question);
  if (consentValue !== undefined) form.append('consent', consentValue);
  if (consentFingerprint !== undefined) form.append('consentFingerprint', consentFingerprint);
  return form;
}

test('issue review fix: storage only happens after a successful, consented vision call', async (t) => {
  const app = startApp();
  t.after(() => app.close());

  await t.test('no consent field means the image is never stored, even with storage on', async () => {
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('what is this?') });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storedImage, null, 'no consent field at all must not store');
    assert.equal(storage.__getCallCount(), 0);
    assert.equal(client.calls.length, 0);
  });

  await t.test('consent=false means the image is never stored', async () => {
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('what is this?', 'false') });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storedImage, null);
    assert.equal(storage.__getCallCount(), 0);
  });

  await t.test('consent=true but a stale/mismatched fingerprint means the image is never stored', async () => {
    // Simulates a browser tab that recorded consent against an older
    // server config (e.g. storage was off, or the provider/retention
    // window was different when the notice was accepted). The bare
    // boolean field alone used to be enough to pass the consent gate;
    // this proves it no longer is.
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const staleFingerprint = JSON.stringify({ provider: 'fake', storeImages: false, retentionMinutes: null });
    const res = await fetch(`${app.baseUrl}/ask`, {
      method: 'POST',
      body: imageForm('what is this?', 'true', staleFingerprint)
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storedImage, null, 'a stale fingerprint must not be treated as current consent');
    assert.equal(storage.__getCallCount(), 0);
    assert.equal(client.calls.length, 0);
  });

  await t.test('consent=true with no fingerprint at all means the image is never stored', async () => {
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: imageForm('what is this?', 'true') });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storedImage, null, 'a bare consent=true with no fingerprint must not store');
    assert.equal(storage.__getCallCount(), 0);
  });

  await t.test('consent=true with a matching fingerprint and a successful answer stores the image and returns its url/expiry', async () => {
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, {
      method: 'POST',
      body: imageForm('what is this?', 'true', VALID_CONSENT_FINGERPRINT)
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.storedImage, 'a successful, consented call should return a storedImage object');
    assert.ok(body.storedImage.expiresAt, 'storedImage should carry an expiry timestamp');
    assert.equal(storage.__getCallCount(), 1);
    const putCommands = client.calls.filter((c) => c.constructor.name === 'PutObjectCommand');
    assert.equal(putCommands.length, 1);
  });

  await t.test('consent=true but a provider error means nothing is stored, even though consent was given', async () => {
    fakeVision.reset();
    fakeVision.setNextReply({ type: 'error', message: 'simulated outage' });
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, {
      method: 'POST',
      body: imageForm('what is this?', 'true', VALID_CONSENT_FINGERPRINT)
    });
    assert.equal(res.status, 502);
    assert.equal(storage.__getCallCount(), 0, 'a failed vision call must never result in a stored image');
    assert.equal(client.calls.length, 0);
  });

  await t.test('consent=true but an invalid/fallback provider reply means nothing is stored', async () => {
    fakeVision.reset();
    fakeVision.setNextReply({ type: 'invalid', reason: 'malformed_json' });
    storage.__resetForTests();
    const client = makeFakeS3Client();
    storage.__setClientForTests(client);

    const res = await fetch(`${app.baseUrl}/ask`, {
      method: 'POST',
      body: imageForm('what is this?', 'true', VALID_CONSENT_FINGERPRINT)
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schemaValid, false);
    assert.equal(body.storedImage, null, 'a fallback reply is not a successful answer and must not be stored');
    assert.equal(storage.__getCallCount(), 0);
  });

  await t.test('a storage failure is logged without image bytes or question text, and does not fail the request', async () => {
    fakeVision.reset();
    storage.__resetForTests();
    const client = makeFakeS3Client();
    client.send = async () => {
      throw new Error('simulated bucket outage');
    };
    storage.__setClientForTests(client);

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let res;
    try {
      const secretQuestion = 'super-secret-question-for-storage-failure-test';
      res = await fetch(`${app.baseUrl}/ask`, {
        method: 'POST',
        body: imageForm(secretQuestion, 'true', VALID_CONSENT_FINGERPRINT)
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(res.status, 200, 'a storage failure must not fail the user-facing request');
    const body = await res.json();
    assert.equal(body.storedImage, null);
    const joined = warnings.join('\n');
    assert.ok(joined.includes('storage failed'), 'the storage failure should be logged');
    assert.ok(!joined.includes('super-secret-question-for-storage-failure-test'), 'the warning must not leak the question text');
    assert.ok(!/\xFF\xD8/.test(joined), 'the warning must not leak raw image bytes');
  });
});
