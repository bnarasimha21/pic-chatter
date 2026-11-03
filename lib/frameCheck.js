'use strict';

const sharp = require('sharp');

const DEFAULT_MEAN_THRESHOLD = Number(process.env.FRAME_MIN_MEAN_LUMINANCE || 10);
const DEFAULT_STDDEV_THRESHOLD = Number(process.env.FRAME_MIN_STDDEV || 4);

// Rejects frames that are near-black or near-uniform (a blank wall, a lens
// cap, a frame grabbed before the camera warmed up) before spending a model
// call on them. Computed locally with sharp's stats, no network call.
async function checkFrame(buffer, options = {}) {
  const meanThreshold = options.meanThreshold ?? DEFAULT_MEAN_THRESHOLD;
  const stddevThreshold = options.stddevThreshold ?? DEFAULT_STDDEV_THRESHOLD;

  const stats = await sharp(buffer).grayscale().stats();
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
