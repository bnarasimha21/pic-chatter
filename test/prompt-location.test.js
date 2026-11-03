'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Issue 4 / issue 3 requirement: the system prompt lives in exactly one
// place (prompts/ask.md), not duplicated into server.js or a provider
// module where it could drift out of sync with what is actually tested.
// This greps the real source files for lines lifted from the prompt and
// fails if any of them show up outside prompts/ask.md.

const ROOT = path.join(__dirname, '..');
const PROMPT_PATH = path.join(ROOT, 'prompts', 'ask.md');

function listSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, files);
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('issue 4: the system prompt text lives only in prompts/ask.md', () => {
  const promptText = fs.readFileSync(PROMPT_PATH, 'utf8');
  const marker = '\n---\n';
  const markerIndex = promptText.indexOf(marker);
  assert.ok(markerIndex !== -1, 'prompts/ask.md should have a doc-comment header separated by a --- marker');
  const instructionBody = promptText.slice(markerIndex + marker.length);

  // Pick a handful of distinctive phrases from the actual instructions
  // (not the doc-comment header) that would only plausibly appear if
  // someone had copy-pasted the prompt into source rather than referencing
  // the file.
  const distinctivePhrases = instructionBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 25)
    .map((line) => line.replace(/^\d+\.\s*/, ''));

  assert.ok(distinctivePhrases.length > 0, 'expected at least one distinctive instruction line to check against');

  const jsFiles = [
    path.join(ROOT, 'server.js'),
    ...listSourceFiles(path.join(ROOT, 'lib'))
  ];

  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const phrase of distinctivePhrases) {
      assert.ok(
        !content.includes(phrase),
        `${path.relative(ROOT, file)} contains a line duplicated from prompts/ask.md: "${phrase}"`
      );
    }
  }
});
