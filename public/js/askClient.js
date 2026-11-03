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
  function buildAskForm(imageBlob, imageFilename, question, consent, consentFingerprint) {
    const form = new FormData();
    form.append('image', imageBlob, imageFilename || 'capture.jpg');
    form.append('question', question);
    // Sent on every request, not just when storage is on: the server is
    // the only place that can verify consent, since a direct API call
    // never goes through this client at all, so it checks this field
    // itself rather than trusting that whatever called /ask went through
    // the browser's consent UI.
    form.append('consent', consent === true ? 'true' : 'false');
    // The fingerprint the page's consent notice was actually built from
    // (provider, storage on/off, retention minutes) at the time consent
    // was recorded. The server recomputes its own current fingerprint and
    // only honours this request's consent if the two match, so a tab left
    // open from before a server-side config change (storage switched on,
    // provider swapped) cannot keep claiming consent it never actually
    // saw the current notice for.
    if (consentFingerprint) form.append('consentFingerprint', consentFingerprint);
    return form;
  }

  async function postAsk(baseUrl, imageBlob, imageFilename, question, signal, consent, consentFingerprint) {
    const form = buildAskForm(imageBlob, imageFilename, question, consent, consentFingerprint);
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
