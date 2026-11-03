'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Consent = require('../public/js/consent');

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k)
  };
}

test('issue 2: consent gate, DOM-level (no DOM required)', () => {
  const storage = makeMemoryStorage();
  const fingerprint = Consent.buildFingerprint({ provider: 'fake', storeImages: false, retentionMinutes: 10 });

  assert.equal(Consent.hasConsented(storage, fingerprint), false, 'no consent recorded yet');

  Consent.recordConsent(storage, fingerprint);
  assert.equal(Consent.hasConsented(storage, fingerprint), true);

  Consent.clearConsent(storage);
  assert.equal(Consent.hasConsented(storage, fingerprint), false);
});

test('issue 2: a storage that throws (e.g. disabled localStorage) is treated as no consent, not a crash', () => {
  const throwingStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); }
  };
  const fingerprint = Consent.buildFingerprint({ provider: 'fake', storeImages: false, retentionMinutes: 10 });
  assert.equal(Consent.hasConsented(throwingStorage, fingerprint), false);
});

test('issue 4: consent recorded while storage was off does not carry over once storage is switched on', () => {
  const storage = makeMemoryStorage();
  const storageOff = Consent.buildFingerprint({ provider: 'anthropic', storeImages: false, retentionMinutes: 10 });
  const storageOn = Consent.buildFingerprint({ provider: 'anthropic', storeImages: true, retentionMinutes: 10 });

  Consent.recordConsent(storage, storageOff);
  assert.equal(Consent.hasConsented(storage, storageOff), true);
  // Storage got turned on server-side after this consent was given; the
  // fingerprint the page computes now no longer matches what was
  // consented to, so the notice must be shown again.
  assert.equal(Consent.hasConsented(storage, storageOn), false, 're-prompt required after storage is toggled on');
});

test('issue 4: consent recorded for one provider does not carry over to a different provider', () => {
  const storage = makeMemoryStorage();
  const fakeFingerprint = Consent.buildFingerprint({ provider: 'fake', storeImages: false, retentionMinutes: 10 });
  const anthropicFingerprint = Consent.buildFingerprint({ provider: 'anthropic', storeImages: false, retentionMinutes: 10 });

  Consent.recordConsent(storage, fakeFingerprint);
  assert.equal(Consent.hasConsented(storage, anthropicFingerprint), false);
});

test('issue 4: clearConsent withdraws consent so the notice is shown again', () => {
  const storage = makeMemoryStorage();
  const fingerprint = Consent.buildFingerprint({ provider: 'fake', storeImages: true, retentionMinutes: 10 });

  Consent.recordConsent(storage, fingerprint);
  assert.equal(Consent.hasConsented(storage, fingerprint), true);

  Consent.clearConsent(storage);
  assert.equal(Consent.hasConsented(storage, fingerprint), false);
});
