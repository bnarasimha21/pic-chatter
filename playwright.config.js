'use strict';

// Playwright config for issue 5's browser-behavior tests only (test/e2e).
// Everything else in this repo uses node --test; Playwright is reserved
// for things that genuinely need a real browser: SpeechRecognition,
// speechSynthesis, and getUserMedia stubs, none of which node --test can
// exercise. The app server is started and stopped directly inside the spec
// file, not via Playwright's webServer option, so it can share the same
// Node process (and therefore the same lib/vision/fake singleton) as the
// test assertions.

module.exports = {
  testDir: './test/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true
  }
};
