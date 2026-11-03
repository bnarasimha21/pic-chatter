// Consent gate: the camera/microphone flow must not start until the user
// has accepted a one-time notice saying the frame is sent to the vision
// provider, whether it is stored, and for how long. Pure functions over an
// injected storage object so this logic is testable with node --test
// without a browser or jsdom.
//
// Consent is recorded against a fingerprint of the facts it was given
// (provider name, whether storage is currently on, and the retention
// window), not just a bare "true". If any of those change - most
// importantly, storage being switched on after someone consented while it
// was off - the stored consent no longer matches the current fingerprint,
// hasConsented() returns false, and the notice is shown again with the new
// facts. A fixed key with no fingerprint (the pre-fix behaviour) would mean
// consent given once never expires even though what was consented to has
// changed underneath it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Consent = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const KEY = 'pic-chatter-consent-v2';

  function buildFingerprint({ provider, storeImages, retentionMinutes } = {}) {
    return JSON.stringify({
      provider: provider || null,
      storeImages: Boolean(storeImages),
      retentionMinutes: storeImages ? Number(retentionMinutes) : null
    });
  }

  function hasConsented(storage, fingerprint) {
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return false;
      const record = JSON.parse(raw);
      return Boolean(record) && record.fingerprint === fingerprint;
    } catch (err) {
      return false;
    }
  }

  function recordConsent(storage, fingerprint) {
    storage.setItem(KEY, JSON.stringify({ fingerprint, consentedAt: new Date().toISOString() }));
  }

  function clearConsent(storage) {
    storage.removeItem(KEY);
  }

  return { KEY, buildFingerprint, hasConsented, recordConsent, clearConsent };
});
