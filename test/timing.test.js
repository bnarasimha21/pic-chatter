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

function imageForm(filePath, question) {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), path.basename(filePath));
  form.append('question', question);
  return form;
}

test('issue 6: Server-Timing and usage are reported for every answered request', async (t) => {
  const app = startApp();
  t.after(() => app.close());

  await t.test('timing marks are present, monotonic, and echoed in both the header and the body', async () => {
    fakeVision.reset();
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what shapes are here?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const body = await res.json();

    const expectedMarks = ['received', 'preprocess_done', 'provider_first_byte', 'provider_done', 'response_sent'];
    for (const mark of expectedMarks) {
      assert.ok(typeof body.timing[mark] === 'number', `expected numeric timing.${mark}`);
    }
    for (let i = 1; i < expectedMarks.length; i++) {
      assert.ok(
        body.timing[expectedMarks[i]] >= body.timing[expectedMarks[i - 1]],
        `${expectedMarks[i]} (${body.timing[expectedMarks[i]]}) should be >= ${expectedMarks[i - 1]} (${body.timing[expectedMarks[i - 1]]})`
      );
    }

    const header = res.headers.get('server-timing');
    assert.ok(header, 'expected a Server-Timing response header');
    for (const mark of expectedMarks) {
      assert.match(header, new RegExp(`${mark};dur=`));
    }
  });

  await t.test('usage and cost are reported for an answered request against a priced model', async () => {
    fakeVision.reset();
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what color is the circle?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    const body = await res.json();
    assert.ok(body.usage, 'expected a usage object');
    assert.ok(typeof body.usage.inputTokens === 'number' && body.usage.inputTokens > 0);
    assert.ok(typeof body.usage.outputTokens === 'number' && body.usage.outputTokens > 0);
    // The fake provider is priced at zero in config/pricing.js, so cost
    // should be a real computed object, not null, and should be exactly zero.
    assert.ok(body.usage.cost, 'expected a cost object for a priced model');
    assert.equal(body.usage.cost.totalCost, 0);
  });

  await t.test('an unusable frame never computes a cost, since no model was called', async () => {
    fakeVision.reset();
    const form = imageForm(path.join(FIXTURE_DIR, 'black.jpg'), 'what is this?');
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(body.model, null);
    assert.equal(body.usage, null);
  });
});
