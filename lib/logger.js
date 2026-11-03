'use strict';

// The only place /ask logs a request. Deliberately takes a fixed, narrow
// set of fields so a future edit cannot accidentally log image bytes or
// the question text: there is no "extra" bucket to stuff them into.
function logAskRequest({ sizeBytes, mime, durationMs, status, provider }) {
  console.log(
    `[ask] size=${sizeBytes}B mime=${mime} duration=${durationMs.toFixed(1)}ms status=${status} provider=${provider}`
  );
}

module.exports = { logAskRequest };
