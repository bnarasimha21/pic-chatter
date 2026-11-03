'use strict';

const sharp = require('sharp');

// Input tokens and latency scale with image size (see readme, "Latency and
// cost"), so every image is downscaled to a configured cap before it goes
// to the vision provider or to storage. The cap is config, not a hardcoded
// number buried in the route.
//
// IMAGE_MAX_DIM/IMAGE_JPEG_QUALITY are read fresh on every call, not cached
// into a module-level constant at require() time. A module-level constant
// would freeze whatever IMAGE_MAX_DIM happened to be set to the first time
// this module was imported in the process; eval/run.js's --sizes comparison
// changes process.env.IMAGE_MAX_DIM between runs in the same process
// specifically so later calls see the new value, which only works if the
// value is read at call time.
function defaultMaxDim() {
  return Number(process.env.IMAGE_MAX_DIM || 1092);
}

function defaultJpegQuality() {
  return Number(process.env.IMAGE_JPEG_QUALITY || 80);
}

// Resizes buffer so its longest side is at most maxDim, re-encoding as JPEG
// at the configured quality. Returns the original buffer untouched if it is
// already within the cap and already a JPEG-compatible format is not
// required, to avoid a pointless re-encode on small inputs.
async function downscaleIfNeeded(buffer, mime, options = {}) {
  const maxDim = options.maxDim ?? defaultMaxDim();
  const quality = options.quality ?? defaultJpegQuality();

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

module.exports = { downscaleIfNeeded, defaultMaxDim, defaultJpegQuality };
