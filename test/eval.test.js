'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Integration test for issue 3's acceptance criterion: running the real
// eval against the real /ask route (fake provider) produces a report that
// contains every required metric. This drives eval/run.js's exported
// main() directly rather than shelling out, so it stays inside
// node --test, but it still goes through real HTTP requests to a real
// Express app, not a mocked scorer.

const RESULTS_DIR = path.join(__dirname, '..', 'eval', 'results');

test('issue 3: the eval runner produces a report with every grounding metric', async () => {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], '--provider', 'fake'];

  try {
    const { main } = require('../eval/run');
    await main();
  } finally {
    process.argv = originalArgv;
  }

  const reportPath = path.join(RESULTS_DIR, 'fake-fake-vision-1.md');
  assert.ok(fs.existsSync(reportPath), `expected a report at ${reportPath}`);
  const report = fs.readFileSync(reportPath, 'utf8');

  assert.match(report, /Grounded accuracy/);
  assert.match(report, /Hallucination rate/);
  assert.match(report, /Abstention rate/);
  assert.match(report, /Schema validity rate/);
  assert.match(report, /visible=false.*agreement/);
  assert.match(report, /Budget check/);
});
