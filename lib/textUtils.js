'use strict';

// Truncates text to at most maxLen characters, cutting at the end of the
// last full sentence that fits rather than mid-word. Falls back to a hard
// cut with an ellipsis if no sentence boundary fits.
function truncateAtSentence(text, maxLen) {
  if (typeof text !== 'string') return text;
  if (text.length <= maxLen) return text;

  const slice = text.slice(0, maxLen);
  const boundaries = ['.', '!', '?'];
  let cutAt = -1;
  for (const b of boundaries) {
    const idx = slice.lastIndexOf(b);
    if (idx > cutAt) cutAt = idx;
  }

  if (cutAt >= 0) {
    return slice.slice(0, cutAt + 1).trim();
  }

  // No sentence boundary within the limit: hard cut, leave room for an ellipsis.
  return slice.slice(0, Math.max(0, maxLen - 1)).trim() + '…';
}

module.exports = { truncateAtSentence };
