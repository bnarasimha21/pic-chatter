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

  assert.equal(Consent.hasConsented(storage), false, 'no consent recorded yet');

  Consent.recordConsent(storage);
  assert.equal(Consent.hasConsented(storage), true);

  Consent.clearConsent(storage);
  assert.equal(Consent.hasConsented(storage), false);
});

test('issue 2: a storage that throws (e.g. disabled localStorage) is treated as no consent, not a crash', () => {
  const throwingStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); }
  };
  assert.equal(Consent.hasConsented(throwingStorage), false);
});
