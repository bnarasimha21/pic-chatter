'use strict';

const { test, expect } = require('@playwright/test');

process.env.VISION_PROVIDER = 'fake';
process.env.RATE_LIMIT_PER_WINDOW = '1000';
process.env.DAILY_CALL_CAP = '1000';

const { app } = require('../../server');
const fakeVision = require('../../lib/vision/fake');

let server;
let baseUrl;

test.beforeAll(() => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  fakeVision.setDelayMs(0);
  await new Promise((resolve) => server.close(resolve));
});

// Stubs SpeechRecognition, speechSynthesis, and getUserMedia so the real
// browser can drive the real page without real hardware. This is injected
// before any page script runs, per Playwright's addInitScript contract.
async function stubBrowserApis(page) {
  await page.addInitScript(() => {
    // A minimal stand-in for the real SpeechRecognition API: just enough of
    // its event-listener surface for index.ejs's setupSpeechRecognition()
    // to attach to, with no inheritance tricks to get confused by.
    class FakeSpeechRecognition {
      constructor() {
        this._listeners = {};
      }
      addEventListener(type, listener) {
        this._listeners[type] = listener;
      }
      start() {
        window.__fakeRecognitionStarted = (window.__fakeRecognitionStarted || 0) + 1;
        if (window.__suppressAutoResult) return;
        setTimeout(() => {
          const listener = this._listeners.result;
          if (listener) {
            listener({ results: [[{ transcript: window.__fakeTranscript || 'what is in this picture?' }]] });
          }
        }, 50);
      }
      // Real Chrome's stop() (as opposed to abort()) delivers a final
      // recognition result for whatever it heard before stopping, then
      // fires 'end'. The old version of this stub only fired 'end', which
      // is exactly why the "Stop still sends the question" bug was
      // invisible to the e2e suite: no test stub ever reproduced the
      // trailing result stop() actually delivers.
      stop() {
        window.__fakeRecognitionStopped = (window.__fakeRecognitionStopped || 0) + 1;
        const resultListener = this._listeners.result;
        if (resultListener) {
          resultListener({ results: [[{ transcript: window.__fakeTranscript || 'what is in this picture?' }]] });
        }
        const endListener = this._listeners.end;
        if (endListener) endListener();
      }
      // Real Chrome's abort() does not deliver a trailing result, only
      // 'end'. This is what index.ejs now calls instead of stop() when the
      // user presses Stop, specifically to avoid the trailing-result bug
      // above.
      //
      // window.__abortStillFiresResult, when set by a test, makes abort()
      // misbehave like some non-Chrome engines reportedly do: deliver a
      // trailing result anyway, asynchronously, before 'end'. That is
      // exactly the "some browser still delivers a trailing result after
      // abort" case index.ejs's own result-handler guard (checking
      // uiState !== 'listening') exists to defend against, independent of
      // which method was called.
      abort() {
        window.__fakeRecognitionAborted = (window.__fakeRecognitionAborted || 0) + 1;
        const resultListener = this._listeners.result;
        const endListener = this._listeners.end;
        if (window.__abortStillFiresResult && resultListener) {
          setTimeout(() => {
            resultListener({ results: [[{ transcript: window.__fakeTranscript || 'what is in this picture?' }]] });
            if (endListener) endListener();
          }, 10);
          return;
        }
        if (endListener) endListener();
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;

    // window.speechSynthesis and window.SpeechSynthesisUtterance are
    // read-only getters on the real browser global in Chromium, so a plain
    // assignment silently no-ops and index.ejs ends up calling the real
    // (voiceless, headless) implementation instead of this stub. A direct
    // property assignment here would be a bug in the test, not the app:
    // defineProperty is required to actually replace them.
    window.__speakCalls = [];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel() {},
        speak(utterance) {
          window.__speakCalls.push(utterance.text);
          setTimeout(() => utterance.dispatchEvent(new Event('end')), 10);
        }
      }
    });
    // Real EventTarget, so index.ejs's utterance.addEventListener('end', ...)
    // works exactly as it would against the browser's own implementation.
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class extends EventTarget {
        constructor(text) {
          super();
          this.text = text;
        }
      }
    });

    // A fake camera stream: a canvas with real varied content (not blank),
    // so the server's frame-usability check does not reject it.
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 480, 360);
      ctx.fillStyle = 'red';
      ctx.fillRect(40, 40, 120, 120);
      ctx.fillStyle = 'blue';
      ctx.beginPath();
      ctx.arc(300, 180, 60, 0, Math.PI * 2);
      ctx.fill();
      return canvas.captureStream(5);
    };
  });
}

test('issue 5: voice path end to end, from consent through a spoken answer', async ({ page }) => {
  fakeVision.reset();
  await stubBrowserApis(page);
  await page.goto(baseUrl);

  await page.click('#consentAccept');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  await expect(page.locator('#micButton')).toBeVisible();

  // Wait for the fake camera stream to actually have a decoded frame before
  // capturing; otherwise the canvas can grab a still-black first frame and
  // the server's frame-usability check correctly (but unhelpfully for this
  // test) rejects it as too dark.
  await page.waitForFunction(() => document.getElementById('cameraPreview').videoWidth > 0);

  await page.click('#captureButton');
  await expect(page.locator('#capturedPreview')).toBeVisible();

  await page.click('#micButton');
  await expect(page.locator('#chatLog .message.bot')).toBeVisible({ timeout: 5000 });

  const speakCalls = await page.evaluate(() => window.__speakCalls);
  expect(speakCalls.length).toBeGreaterThan(0);

  const userMessages = await page.locator('#chatLog .message.user').allTextContents();
  expect(userMessages[0]).toBe('what is in this picture?');
});

test('issue 5: the stop button aborts an in-flight ask and returns the UI to idle', async ({ page }) => {
  fakeVision.reset();
  fakeVision.setDelayMs(3000); // hold the response open long enough to click stop
  await stubBrowserApis(page);
  await page.goto(baseUrl);

  await page.click('#consentAccept');
  await page.waitForFunction(() => document.getElementById('cameraPreview').videoWidth > 0);
  await page.click('#captureButton');
  await expect(page.locator('#capturedPreview')).toBeVisible();

  await page.fill('#textQuestion', 'is there a cat here?');
  await page.click('#textSubmit');

  await expect(page.locator('#status')).toHaveText(/Thinking/);
  await expect(page.locator('#stopButton')).toBeEnabled();

  await page.click('#stopButton');
  await expect(page.locator('#status')).toHaveText(/Capture a picture/);
  await expect(page.locator('#stopButton')).toBeDisabled();

  fakeVision.setDelayMs(0);
});

test('issue review fix: pressing Stop while still listening never sends the question, because the app uses abort() (no trailing result) instead of stop()', async ({ page }) => {
  // This reproduces the bug from the second adversarial review: the old
  // code called recognition.stop(), and real Chrome's stop() (unlike
  // abort()) delivers a final recognition result for whatever it heard
  // before stopping. That meant a photo could still be captured, sent to
  // the vision provider, and stored after the user explicitly pressed
  // Stop. The old fake stub's stop() only fired 'end', never a trailing
  // 'result', which is exactly why this class of bug was invisible to the
  // e2e suite before. This test's stub fires the trailing result on
  // stop() (as real Chrome does) and asserts the app never reaches it,
  // because it now calls abort() instead.
  fakeVision.reset();
  await page.addInitScript(() => {
    window.__suppressAutoResult = true;
  });
  await stubBrowserApis(page);
  await page.goto(baseUrl);

  await page.click('#consentAccept');
  await page.waitForFunction(() => document.getElementById('cameraPreview').videoWidth > 0);
  await page.click('#captureButton');
  await expect(page.locator('#capturedPreview')).toBeVisible();

  await page.click('#micButton');
  await expect(page.locator('#status')).toHaveText(/Listening/);

  await page.click('#micButton'); // second click while listening = Stop
  await expect(page.locator('#status')).toHaveText(/Capture a picture/);

  // The fake's stop() would have fired a trailing result synchronously
  // (see the stub above); give any microtask/callback a moment to run,
  // then confirm nothing was ever asked and no bot message ever appeared.
  await page.waitForTimeout(150);

  const abortedCount = await page.evaluate(() => window.__fakeRecognitionAborted || 0);
  const stoppedCount = await page.evaluate(() => window.__fakeRecognitionStopped || 0);
  expect(abortedCount).toBeGreaterThan(0);
  expect(stoppedCount).toBe(0);

  await expect(page.locator('#chatLog .message.user')).toHaveCount(0);
  await expect(page.locator('#chatLog .message.bot')).toHaveCount(0);
});

test('issue review fix: a trailing speech result delivered after abort() is defensively discarded, so it still never sends the question', async ({ page }) => {
  // Defense in depth: even if some browser's abort() still delivers a
  // trailing result (unlike real Chrome), the result handler's own state
  // check (uiState !== 'listening') must discard it, because by the time
  // Stop has been clicked the app's state is no longer 'listening'.
  fakeVision.reset();
  await page.addInitScript(() => {
    window.__suppressAutoResult = true;
    window.__abortStillFiresResult = true;
  });
  await stubBrowserApis(page);
  await page.goto(baseUrl);

  await page.click('#consentAccept');
  await page.waitForFunction(() => document.getElementById('cameraPreview').videoWidth > 0);
  await page.click('#captureButton');
  await expect(page.locator('#capturedPreview')).toBeVisible();

  await page.click('#micButton');
  await expect(page.locator('#status')).toHaveText(/Listening/);

  await page.click('#micButton'); // Stop, while still listening
  await expect(page.locator('#status')).toHaveText(/Capture a picture/);

  // The stubbed abort() fires its trailing result ~10ms later; wait well
  // past that before asserting nothing was ever asked.
  await page.waitForTimeout(150);

  await expect(page.locator('#chatLog .message.user')).toHaveCount(0);
  await expect(page.locator('#chatLog .message.bot')).toHaveCount(0);
});

test('third adversarial review fix: typing and submitting a question while the mic is listening does not also fire the mic\'s question', async ({ page }) => {
  // Reproduces the exact race from the third review: press mic, type a
  // question, press Enter (submit the text form) while still listening,
  // then the mic's own recognizer still has a result in flight. Before
  // the fix, the text form's submit handler dispatched ASK_START directly;
  // the reducer has no transition for ASK_START from 'listening' (see
  // state.js), so uiState silently stayed 'listening' forever. That meant
  // (a) the earlier abort()-vs-stop() guard (uiState !== 'listening') never
  // kicked in, so a trailing speech result could still reach askQuestion(),
  // and (b) two concurrent requests fired for two different questions.
  //
  // The fix makes the text form abort() the live recognition and dispatch
  // STOP (leaving 'listening') before starting the typed question, exactly
  // like the mic button's own "click while listening" case already does.
  // window.__abortStillFiresResult simulates a non-Chrome engine whose
  // abort() still delivers a trailing result asynchronously, to prove the
  // fix holds even in that case: by the time it arrives, uiState is no
  // longer 'listening' (it is 'asking', from the typed question), so the
  // result handler's own guard discards it.
  fakeVision.reset();
  await page.addInitScript(() => {
    window.__suppressAutoResult = true;
    window.__abortStillFiresResult = true;
    window.__fakeTranscript = 'is there a dog here?';
  });
  await stubBrowserApis(page);
  await page.goto(baseUrl);

  await page.click('#consentAccept');
  await page.waitForFunction(() => document.getElementById('cameraPreview').videoWidth > 0);
  await page.click('#captureButton');
  await expect(page.locator('#capturedPreview')).toBeVisible();

  // Start listening with the mic. __suppressAutoResult means no automatic
  // result fires, so the mic is left genuinely "still listening".
  await page.click('#micButton');
  await expect(page.locator('#status')).toHaveText(/Listening/);

  // Type a different question and submit it while the mic is still live.
  await page.fill('#textQuestion', 'what color is the shape?');
  await page.click('#textSubmit');

  // The typed question's answer should come back; wait for it.
  await expect(page.locator('#chatLog .message.bot')).toBeVisible({ timeout: 5000 });

  // The stubbed abort() fires its trailing (mic-dictated) result ~10ms
  // later; wait well past that, and past the typed question's own answer,
  // before asserting the mic's question never also fired.
  await page.waitForTimeout(300);

  const userMessages = await page.locator('#chatLog .message.user').allTextContents();
  expect(userMessages).toEqual(['what color is the shape?']);
  await expect(page.locator('#chatLog .message.bot')).toHaveCount(1);
  expect(fakeVision.getCallCount()).toBe(1);

  const abortedCount = await page.evaluate(() => window.__fakeRecognitionAborted || 0);
  expect(abortedCount).toBeGreaterThan(0);
});
