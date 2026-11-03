'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { downscaleIfNeeded } = require('../lib/imagePrep');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

test('issue 6: downscaling actually reaches the configured cap', async () => {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'large.jpg'));
  const before = await sharp(bytes).metadata();
  assert.ok(Math.max(before.width, before.height) > 1092, 'fixture should start out larger than the default cap');

  const result = await downscaleIfNeeded(bytes, 'image/jpeg', { maxDim: 500 });
  assert.equal(result.resized, true);
  assert.ok(Math.max(result.width, result.height) <= 500, `resized longest side ${Math.max(result.width, result.height)} should be <= 500`);

  const after = await sharp(result.buffer).metadata();
  assert.equal(after.format, 'jpeg');
  assert.ok(Math.max(after.width, after.height) <= 500);
});

test('issue 6: an image already under the cap passes through unresized and keeps its original mime', async () => {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'sample.jpg'));
  const result = await downscaleIfNeeded(bytes, 'image/png', { maxDim: 1092 });
  assert.equal(result.resized, false);
  assert.equal(result.mime, 'image/png', 'mime should pass through unchanged on the fast path, not be hardcoded to jpeg');
  assert.equal(Buffer.compare(result.buffer, bytes), 0);
});
