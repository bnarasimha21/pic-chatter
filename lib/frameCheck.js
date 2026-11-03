'use strict';

const sharp = require('sharp');

const DEFAULT_MEAN_THRESHOLD = Number(process.env.FRAME_MIN_MEAN_LUMINANCE || 10);
const DEFAULT_STDDEV_THRESHOLD = Number(process.env.FRAME_MIN_STDDEV || 4);
// A small on-disk file can still decode to an enormous pixel buffer (e.g. a
// 776KB 16000x16000 PNG decodes to ~768MB of raw pixels), and MAX_UPLOAD_BYTES
// only caps the former. sharp's own default limitInputPixels (~268 megapixels)
// is too high to catch that case, so a lower, configurable cap is set here and
// passed into sharp() itself, which checks image dimensions against it before
// doing the full pixel decode that stats() would otherwise trigger.
const DEFAULT_MAX_PIXELS = Number(process.env.FRAME_MAX_PIXELS || 30_000_000);

// Rejects frames that are near-black or near-uniform (a blank wall, a lens
// cap, a frame grabbed before the camera warmed up) before spending a model
// call on them. Computed locally with sharp's stats, no network call.
async function checkFrame(buffer, options = {}) {
  const meanThreshold = options.meanThreshold ?? DEFAULT_MEAN_THRESHOLD;
  const stddevThreshold = options.stddevThreshold ?? DEFAULT_STDDEV_THRESHOLD;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;

  let stats;
  try {
    stats = await sharp(buffer, { limitInputPixels: maxPixels }).grayscale().stats();
  } catch (err) {
    if (/exceeds pixel limit|input image exceeds/i.test(err.message || '')) {
      return { usable: false, reason: 'too_large', mean: null, stdev: null };
    }
    throw err;
  }
  const channel = stats.channels[0];
  const mean = channel.mean;
  const stdev = channel.stdev;

  if (mean < meanThreshold) {
    return { usable: false, reason: 'too_dark', mean, stdev };
  }
  if (stdev < stddevThreshold) {
    return { usable: false, reason: 'too_uniform', mean, stdev };
  }
  return { usable: true, reason: null, mean, stdev };
}

module.exports = { checkFrame };
