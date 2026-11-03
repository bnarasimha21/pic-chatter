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
        setTimeout(() => {
          const listener = this._listeners.result;
          if (listener) {
            listener({ results: [[{ transcript: window.__fakeTranscript || 'what is in this picture?' }]] });
          }
        }, 50);
      }
      stop() {
        window.__fakeRecognitionStopped = (window.__fakeRecognitionStopped || 0) + 1;
        const listener = this._listeners.end;
        if (listener) listener();
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
