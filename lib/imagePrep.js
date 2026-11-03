'use strict';

const sharp = require('sharp');

// Input tokens and latency scale with image size (see readme, "Latency and
// cost"), so every image is downscaled to a configured cap before it goes
// to the vision provider or to storage. The cap is config, not a hardcoded
// number buried in the route.
const DEFAULT_MAX_DIM = Number(process.env.IMAGE_MAX_DIM || 1092);
const DEFAULT_JPEG_QUALITY = Number(process.env.IMAGE_JPEG_QUALITY || 80);

// Resizes buffer so its longest side is at most maxDim, re-encoding as JPEG
// at the configured quality. Returns the original buffer untouched if it is
// already within the cap and already a JPEG-compatible format is not
// required, to avoid a pointless re-encode on small inputs.
async function downscaleIfNeeded(buffer, mime, options = {}) {
  const maxDim = options.maxDim ?? DEFAULT_MAX_DIM;
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;

  const image = sharp(buffer);
  const metadata = await image.metadata();
  const longestSide = Math.max(metadata.width || 0, metadata.height || 0);

  if (longestSide <= maxDim) {
    return { buffer, mime, width: metadata.width, height: metadata.height, resized: false };
  }

  const resized = await image
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: resized.data,
    mime: 'image/jpeg',
    width: resized.info.width,
    height: resized.info.height,
    resized: true
  };
}

module.exports = { downscaleIfNeeded, DEFAULT_MAX_DIM, DEFAULT_JPEG_QUALITY };
