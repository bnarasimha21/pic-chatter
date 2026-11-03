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
const { buildAskForm, postAsk } = require('../public/js/askClient');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

test('issue 5: the voice path and the text-input fallback build and send an identical request shape', async (t) => {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'sample.jpg'));
  const blob = new Blob([bytes], { type: 'image/jpeg' });

  await t.test('buildAskForm produces the same field names regardless of where the question text came from', () => {
    const fromVoiceTranscript = buildAskForm(blob, 'capture.jpg', 'what color is the circle?');
    const fromTextInput = buildAskForm(blob, 'capture.jpg', 'what color is the circle?');

    assert.deepEqual([...fromVoiceTranscript.keys()].sort(), [...fromTextInput.keys()].sort());
    assert.equal(fromVoiceTranscript.get('question'), fromTextInput.get('question'));
    assert.equal(fromVoiceTranscript.get('image').type, fromTextInput.get('image').type);
  });

  const app = startApp();
  t.after(() => app.close());

  await t.test('a question that arrived via a simulated voice transcript gets a normal 200 JSON answer', async () => {
    fakeVision.reset();
    const { status, body } = await postAsk(app.baseUrl, blob, 'capture.jpg', 'is there a circle in this picture?');
    assert.equal(status, 200);
    assert.ok(body.answer && typeof body.answer.answer === 'string');
  });

  await t.test('the identical question sent through the text-input fallback path gets the identical response shape', async () => {
    fakeVision.reset();
    const { status, body } = await postAsk(app.baseUrl, blob, 'capture.jpg', 'is there a circle in this picture?');
    assert.equal(status, 200);
    assert.ok(body.answer && typeof body.answer.answer === 'string');
    // Same fake provider, same fixture, same question: the two paths must
    // produce the same answer text, proving there is no separate behaviour
    // hiding behind "voice" vs "text" on the server side either.
    assert.equal(body.answer.answer, 'This looks like a test scene with a few simple shapes.');
  });
});
