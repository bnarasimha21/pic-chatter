'use strict';

// Compares measured samples against eval/budgets.json. Used by the eval
// runner (fake provider path only, see eval/run.js) and by
// test/budgets.test.js, which proves the check actually fails when the
// fake provider's injected delay pushes latency over budget.

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

function checkBudgets(samples, budgets) {
  const serverMsValues = samples.map((s) => s.serverMs).sort((a, b) => a - b);
  const tokenValues = samples.map((s) => s.totalTokens).filter((v) => typeof v === 'number');

  const p95ServerMs = percentile(serverMsValues, 95);
  const maxTokensPerAnswer = tokenValues.length ? Math.max(...tokenValues) : 0;

  const failures = [];
  if (budgets.p95ServerMs !== undefined && p95ServerMs > budgets.p95ServerMs) {
    failures.push(`p95 server time ${p95ServerMs.toFixed(1)}ms exceeds budget ${budgets.p95ServerMs}ms`);
  }
  if (budgets.maxTokensPerAnswer !== undefined && maxTokensPerAnswer > budgets.maxTokensPerAnswer) {
    failures.push(`max tokens per answer ${maxTokensPerAnswer} exceeds budget ${budgets.maxTokensPerAnswer}`);
  }

  return { pass: failures.length === 0, p95ServerMs, maxTokensPerAnswer, failures };
}

module.exports = { checkBudgets, percentile };
