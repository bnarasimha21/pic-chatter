// Consent gate: the camera/microphone flow must not start until the user
// has accepted a one-time notice saying the frame is sent to the vision
// provider, whether it is stored, and for how long. Pure functions over an
// injected storage object so this logic is testable with node --test
// without a browser or jsdom.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Consent = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const KEY = 'pic-chatter-consent-v1';

  function hasConsented(storage) {
    try {
      return storage.getItem(KEY) === 'true';
    } catch (err) {
      return false;
    }
  }

  function recordConsent(storage) {
    storage.setItem(KEY, 'true');
  }

  function clearConsent(storage) {
    storage.removeItem(KEY);
  }

  return { KEY, hasConsented, recordConsent, clearConsent };
});
