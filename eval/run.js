#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { makeImages } = require('./make_images');
const { score } = require('./score');
const { checkBudgets } = require('./budgets');
const { getPricing } = require('../config/pricing');

const CASES_PATH = path.join(__dirname, 'cases.json');
const IMAGES_DIR = path.join(__dirname, 'images');
const RESULTS_DIR = path.join(__dirname, 'results');
const BUDGETS_PATH = path.join(__dirname, 'budgets.json');

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'fake' },
      yes: { type: 'boolean', default: false },
      model: { type: 'string' },
      sizes: { type: 'string' } // comma-separated list of IMAGE_MAX_DIM values to compare, e.g. "1092,400"
    }
  });

  const provider = values.provider;
  process.env.VISION_PROVIDER = provider;
  if (values.model) process.env.VISION_MODEL = values.model;
  // The eval posts many requests back to back from one process; the
  // per-request rate limit and daily cap exist to protect real users, not
  // this runner, so they are relaxed here rather than in the app itself.
  process.env.RATE_LIMIT_PER_WINDOW = process.env.RATE_LIMIT_PER_WINDOW || '100000';
  process.env.DAILY_CALL_CAP = process.env.DAILY_CALL_CAP || '100000';

  if (!fs.existsSync(IMAGES_DIR) || fs.readdirSync(IMAGES_DIR).length === 0) {
    await makeImages();
  }

  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));

  if (provider === 'anthropic') {
    const model = process.env.VISION_MODEL || require('../lib/vision/anthropic').DEFAULT_MODEL;
    const estimate = estimateAnthropicRun(cases, model);
    printEstimate(estimate, model);
    if (!values.yes) {
      console.log('\nRefusing to run against a real provider without --yes. Add --yes to proceed.');
      process.exitCode = 1;
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set; cannot run against the anthropic provider.');
      process.exitCode = 1;
      return;
    }
  }

  const sizes = values.sizes ? values.sizes.split(',').map((s) => Number(s.trim())) : [Number(process.env.IMAGE_MAX_DIM || 1092)];

  const runsBySize = [];
  for (const maxDim of sizes) {
    process.env.IMAGE_MAX_DIM = String(maxDim);
    // eslint-disable-next-line global-require
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const fakeVision = provider === 'fake' ? require('../lib/vision/fake') : null;
    if (fakeVision) fakeVision.reset();

    const { responses, samples } = await runCases(cases, baseUrl, fakeVision);
    await new Promise((resolve) => server.close(resolve));

    const metrics = score(cases, responses);
    runsBySize.push({ maxDim, metrics, samples, responses });
  }

  const primary = runsBySize[0];
  const model = primary.responses.find((r) => r.model)?.model || process.env.VISION_MODEL || 'unknown';

  let budgetResult = null;
  if (provider === 'fake') {
    budgetResult = checkBudgets(primary.samples, JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')));
  }

  writeReport({ provider, model, cases, runsBySize, budgetResult });
  printSummary(primary.metrics, budgetResult);

  if (budgetResult && !budgetResult.pass) {
    console.error('\nBudget check FAILED:');
    for (const failure of budgetResult.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

async function runCases(cases, baseUrl, fakeVision) {
  const responses = [];
  const samples = [];

  for (const testCase of cases) {
    if (fakeVision && testCase.fakeScript) {
      fakeVision.setNextReply(testCase.fakeScript);
    }

    const imagePath = path.join(IMAGES_DIR, testCase.image);
    const bytes = fs.readFileSync(imagePath);
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: 'image/png' }), testCase.image);
    form.append('question', testCase.question);

    const start = Date.now();
    const res = await fetch(`${baseUrl}/ask`, { method: 'POST', body: form });
    const serverMs = Date.now() - start;
    const body = await res.json();

    const schemaValid = res.status === 200 && body.schemaValid === true;
    const totalTokens = body.usage ? (body.usage.inputTokens || 0) + (body.usage.outputTokens || 0) : undefined;

    responses.push({ answer: body.answer, model: body.model, usage: body.usage, schemaValid, status: res.status });
    samples.push({ serverMs, totalTokens });
  }

  return { responses, samples };
}

function estimateAnthropicRun(cases, model) {
  // Planning figure, not a measurement: assumes roughly 1,000 input tokens
  // per small eval image (see readme) plus a short question and a short
  // structured output per case.
  const estimatedInputTokensPerCase = 1050;
  const estimatedOutputTokensPerCase = 60;
  const inputTokens = cases.length * estimatedInputTokensPerCase;
  const outputTokens = cases.length * estimatedOutputTokensPerCase;
  const pricing = getPricing(model);
  const cost = pricing
    ? (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok
    : null;
  return { caseCount: cases.length, inputTokens, outputTokens, cost, pricing };
}

function printEstimate(estimate, model) {
  console.log(`Planned run: ${estimate.caseCount} images against ${model}.`);
  console.log(`Estimated input tokens: ~${estimate.inputTokens.toLocaleString()}`);
  console.log(`Estimated output tokens: ~${estimate.outputTokens.toLocaleString()}`);
  if (estimate.cost !== null) {
    console.log(`Estimated cost: ~$${estimate.cost.toFixed(4)} (priced from config/pricing.js, checked ${estimate.pricing.checkedAt})`);
  } else {
    console.log(`No committed price for ${model} in config/pricing.js; add one before relying on a cost estimate.`);
  }
}

function printSummary(metrics, budgetResult) {
  console.log('\nEval results:');
  console.log(`  total cases:            ${metrics.totalCases}`);
  console.log(`  grounded accuracy:      ${fmtPct(metrics.groundedAccuracy)}`);
  console.log(`  hallucination rate:     ${fmtPct(metrics.hallucinationRate)}`);
  console.log(`  abstention rate:        ${fmtPct(metrics.abstentionRate)}`);
  console.log(`  schema validity rate:   ${fmtPct(metrics.schemaValidityRate)}`);
  console.log(`  visible/no-probe agree: ${fmtPct(metrics.absentProbeVisibleAgreement)}`);
  if (budgetResult) {
    console.log(`  p95 server time:        ${budgetResult.p95ServerMs.toFixed(1)}ms`);
    console.log(`  max tokens/answer:      ${budgetResult.maxTokensPerAnswer}`);
  }
}

function fmtPct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function writeReport({ provider, model, cases, runsBySize, budgetResult }) {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(RESULTS_DIR, `${provider}-${model}.md`);

  let md = `# Eval report: ${provider} / ${model}\n\n`;
  md += `Date: ${date}\n\n`;
  md += `Case count: ${cases.length}\n\n`;

  for (const run of runsBySize) {
    md += `## Image size cap: ${run.maxDim}px (longest side)\n\n`;
    md += '| Metric | Value |\n|---|---|\n';
    md += `| Grounded accuracy | ${fmtPct(run.metrics.groundedAccuracy)} |\n`;
    md += `| Hallucination rate (absent probes) | ${fmtPct(run.metrics.hallucinationRate)} |\n`;
    md += `| Abstention rate (unanswerable) | ${fmtPct(run.metrics.abstentionRate)} |\n`;
    md += `| Schema validity rate | ${fmtPct(run.metrics.schemaValidityRate)} |\n`;
    md += `| visible=false / "no" agreement | ${fmtPct(run.metrics.absentProbeVisibleAgreement)} |\n`;
    const avgServerMs = run.samples.reduce((sum, s) => sum + s.serverMs, 0) / run.samples.length;
    const avgTokens = run.samples.reduce((sum, s) => sum + (s.totalTokens || 0), 0) / run.samples.length;
    md += `| Average server time | ${avgServerMs.toFixed(1)}ms |\n`;
    md += `| Average tokens per answer | ${avgTokens.toFixed(0)} |\n\n`;
  }

  if (budgetResult) {
    md += `## Budget check (fake provider, eval/budgets.json)\n\n`;
    md += budgetResult.pass ? 'PASS\n\n' : `FAIL:\n${budgetResult.failures.map((f) => `- ${f}`).join('\n')}\n\n`;
  }

  md += 'Note: these are synthetic shapes/text/count images, not photographs; they are easier to get right than a real scene.\n';

  fs.writeFileSync(filePath, md);
  console.log(`\nReport written to ${filePath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
