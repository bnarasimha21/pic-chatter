(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PicChatterAsk = factory();
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // The one place that builds the /ask request body. Both the voice path
  // (a SpeechRecognition transcript) and the text-input fallback path call
  // this same function with their question string, so the two paths are
  // provably identical from here on: there is no separate "voice request"
  // and "text request" shape to drift apart. See test/speech-fallback.test.js.
  function buildAskForm(imageBlob, imageFilename, question) {
    const form = new FormData();
    form.append('image', imageBlob, imageFilename || 'capture.jpg');
    form.append('question', question);
    return form;
  }

  async function postAsk(baseUrl, imageBlob, imageFilename, question, signal) {
    const form = buildAskForm(imageBlob, imageFilename, question);
    const res = await fetch(`${baseUrl}/ask`, { method: 'POST', body: form, signal });
    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      body = null;
    }
    return { status: res.status, body };
  }

  return { buildAskForm, postAsk };
}));
