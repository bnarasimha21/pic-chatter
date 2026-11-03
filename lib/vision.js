'use strict';

// The provider seam. Every vision call in the app goes through describe(),
// so swapping VISION_PROVIDER never touches server.js or the route code.
//
// describe({ imageBytes, mime, question, signal }) resolves to:
//   { answer: <structured answer, see lib/answerSchema.js>, model: string,
//     usage: { inputTokens: number, outputTokens: number }, raw?: any }
//
// Implementations live in lib/vision/<provider>.js. The provider module is
// required lazily so picking "fake" never pulls in a real SDK or needs a key.

const PROVIDERS = {
  fake: './vision/fake',
  anthropic: './vision/anthropic'
};

function resolveProviderName() {
  return (process.env.VISION_PROVIDER || 'fake').trim();
}

function loadProvider(name) {
  const modulePath = PROVIDERS[name];
  if (!modulePath) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown VISION_PROVIDER "${name}". Known providers: ${known}.`);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(modulePath);
}

// Fails fast and clearly at startup if the selected provider has no key,
// instead of failing on the first request a user makes.
function assertConfigured(name = resolveProviderName()) {
  const provider = loadProvider(name);
  if (typeof provider.assertConfigured === 'function') {
    provider.assertConfigured();
  }
}

async function describe(request) {
  const name = resolveProviderName();
  const provider = loadProvider(name);
  const result = await provider.describe(request);
  return { ...result, providerName: name };
}

module.exports = { describe, assertConfigured, resolveProviderName, loadProvider };
