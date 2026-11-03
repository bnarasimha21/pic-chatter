'use strict';

// Generates the eval's ground-truth fixture images. Every image is drawn
// from a fixed SVG string, so content is exact by construction: no human
// labelling, no licensing risk, and the same seed always produces the same
// bytes (eval/images.sha256.json records the expected hashes; see
// test/eval-images.test.js).
//
// Images are deliberately simple shapes, text and counts: good enough to
// check grounding, nowhere near a real photograph. The readme says so.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const IMAGES_DIR = path.join(__dirname, 'images');
const HASHES_PATH = path.join(__dirname, 'images.sha256.json');

const IMAGES = {
  'shapes.png': `
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
      <rect width="300" height="200" fill="white"/>
      <rect x="30" y="60" width="80" height="80" fill="#d62728"/>
      <circle cx="230" cy="100" r="40" fill="#1f77b4"/>
    </svg>`,
  'sign.png': `
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
      <rect width="300" height="200" fill="#f5f0e6"/>
      <rect x="40" y="60" width="220" height="80" fill="white" stroke="black" stroke-width="4"/>
      <text x="70" y="115" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="black">OPEN</text>
    </svg>`,
  'circles.png': `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="160">
      <rect width="320" height="160" fill="white"/>
      <circle cx="50" cy="80" r="28" fill="#2ca02c"/>
      <circle cx="130" cy="80" r="28" fill="#2ca02c"/>
      <circle cx="210" cy="80" r="28" fill="#2ca02c"/>
      <circle cx="290" cy="80" r="28" fill="#2ca02c"/>
    </svg>`,
  'texture.png': `
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
      <rect width="300" height="200" fill="#9fc5e8"/>
      <rect x="0" y="0" width="300" height="20" fill="#cfe2f3"/>
      <rect x="0" y="40" width="300" height="20" fill="#cfe2f3"/>
      <rect x="0" y="80" width="300" height="20" fill="#cfe2f3"/>
      <rect x="0" y="120" width="300" height="20" fill="#cfe2f3"/>
      <rect x="0" y="160" width="300" height="20" fill="#cfe2f3"/>
    </svg>`,
  'room.png': `
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
      <rect width="300" height="200" fill="#4a4a4a"/>
      <rect x="40" y="120" width="100" height="60" fill="#6b6b6b"/>
      <rect x="180" y="40" width="60" height="140" fill="#5a5a5a"/>
    </svg>`
};

async function makeImages() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const hashes = {};

  for (const [filename, svg] of Object.entries(IMAGES)) {
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
    hashes[filename] = crypto.createHash('sha256').update(buffer).digest('hex');
  }

  fs.writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2) + '\n');
  return hashes;
}

if (require.main === module) {
  makeImages().then((hashes) => {
    console.log('Generated eval fixture images:');
    for (const [name, hash] of Object.entries(hashes)) {
      console.log(`  ${name}  sha256:${hash}`);
    }
  });
}

module.exports = { makeImages, IMAGES_DIR, HASHES_PATH };
