'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { makeImages, IMAGES_DIR, HASHES_PATH } = require('../eval/make_images');

test('issue 3: fixture images are generated deterministically (same seed, same bytes)', async () => {
  const expectedHashes = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));

  // Regenerate into the same directory and confirm every file still hashes
  // to the value committed in eval/images.sha256.json.
  await makeImages();

  for (const [filename, expectedHash] of Object.entries(expectedHashes)) {
    const buffer = fs.readFileSync(`${IMAGES_DIR}/${filename}`);
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    assert.equal(actualHash, expectedHash, `${filename} should regenerate to the committed hash`);
  }
});
