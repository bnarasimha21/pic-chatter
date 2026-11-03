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
const { checkBudgets } = require('../eval/budgets');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function imageForm(filePath, question) {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), path.basename(filePath));
  form.append('question', question);
  return form;
}

test('issue 6: the budget check is testable, including the failure path, without real network latency', async (t) => {
  const app = startApp();
  t.after(() => app.close());

  await t.test('checkBudgets passes against fast fake-provider samples', async () => {
    fakeVision.reset();
    fakeVision.setDelayMs(0);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what is in the picture?');
      const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
      const serverMs = Date.now() - start;
      const body = await res.json();
      samples.push({ serverMs, totalTokens: body.usage.inputTokens + body.usage.outputTokens });
    }

    const result = checkBudgets(samples, { p95ServerMs: 500, maxTokensPerAnswer: 600 });
    assert.equal(result.pass, true, `expected the budget check to pass, got failures: ${result.failures.join(', ')}`);
  });

  await t.test('an injected provider delay makes the budget check fail, proving it is actually exercised', async () => {
    fakeVision.reset();
    fakeVision.setDelayMs(600); // comfortably over the 500ms p95 budget used below
    t.after(() => fakeVision.setDelayMs(0));

    const samples = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'what is in the picture?');
      const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
      const serverMs = Date.now() - start;
      const body = await res.json();
      samples.push({ serverMs, totalTokens: body.usage.inputTokens + body.usage.outputTokens });
    }

    const result = checkBudgets(samples, { p95ServerMs: 500, maxTokensPerAnswer: 600 });
    assert.equal(result.pass, false, 'the injected 600ms delay should push p95 server time over the 500ms budget');
    assert.ok(result.failures.some((f) => /p95 server time/.test(f)));
  });

  await t.test('a tiny token budget makes the check fail on token count, independent of latency', async () => {
    fakeVision.reset();
    fakeVision.setDelayMs(0);
    const form = imageForm(path.join(FIXTURE_DIR, 'sample.jpg'), 'describe everything you can see here in detail please');
    const start = Date.now();
    const res = await fetch(`${app.baseUrl}/ask`, { method: 'POST', body: form });
    const serverMs = Date.now() - start;
    const body = await res.json();
    const totalTokens = body.usage.inputTokens + body.usage.outputTokens;

    const result = checkBudgets([{ serverMs, totalTokens }], { p95ServerMs: 500, maxTokensPerAnswer: 1 });
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((f) => /max tokens per answer/.test(f)));
  });
});
