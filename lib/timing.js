'use strict';

// Five marks per /ask request: received, preprocess_done, provider_first_byte,
// provider_done, response_sent. The vision call in this app is not streamed,
// so provider_first_byte is approximated as the moment describe() resolves,
// the same instant as provider_done; the gap would only be non-zero behind a
// streaming provider. That approximation is documented here and in the readme.
function createTimer() {
  const start = process.hrtime.bigint();
  const marks = {};

  function mark(name) {
    const now = process.hrtime.bigint();
    const ms = Number(now - start) / 1e6;
    marks[name] = ms;
    return ms;
  }

  function toServerTimingHeader() {
    return Object.entries(marks)
      .map(([name, ms]) => `${name};dur=${ms.toFixed(2)}`)
      .join(', ');
  }

  function toJSON() {
    return { ...marks };
  }

  return { mark, toServerTimingHeader, toJSON };
}

module.exports = { createTimer };
