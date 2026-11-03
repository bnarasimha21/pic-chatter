'use strict';

// Deterministic, offline vision provider used by default (VISION_PROVIDER=fake)
// and by every integration test. It never makes a network call.
//
// Tests that need specific behaviour (a truncated reply, a refusal, an
// injected delay, an abort) require this same module directly (Node's
// require cache gives them the same singleton the running app uses) and
// drive it through the control functions at the bottom of this file.
//
// For the eval (issue 3), each case in eval/cases.json carries the exact
// reply this provider should give for that case (right or deliberately
// wrong, to exercise every scorer path); the eval runner calls
// setNextReply() with that case's scripted reply immediately before
// posting the case to /ask. That script travels with the case data, so it
// is effectively the "sidecar" the fake answers from.

const FAKE_MODEL = 'fake-vision-1';

const state = {
  queue: [],
  callCount: 0,
  abortCount: 0,
  lastRequest: null,
  delayMs: 0
};

function reset() {
  state.queue = [];
  state.callCount = 0;
  state.abortCount = 0;
  state.lastRequest = null;
  state.delayMs = 0;
}

// Queues one scripted reply, consumed by the next describe() call.
// Shapes: { type: 'valid', answer }, { type: 'invalid', reason },
// { type: 'truncated' }, { type: 'refused' }, { type: 'error', message }.
function setNextReply(reply) {
  state.queue.push(reply);
}

function setDelayMs(ms) {
  state.delayMs = ms;
}

function getCallCount() {
  return state.callCount;
}

function getAbortCount() {
  return state.abortCount;
}

function getLastRequest() {
  return state.lastRequest;
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(makeAbortError());
        return;
      }
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(makeAbortError());
      }, { once: true });
    }
  });
}

function makeAbortError() {
  const err = new Error('The vision call was aborted');
  err.name = 'AbortError';
  return err;
}

function defaultAnswer(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('cat')) {
    return { answer: 'I do not see a cat in this picture.', confidence: 'high', visible: false, reason_if_unclear: null };
  }
  return {
    answer: 'This looks like a test scene with a few simple shapes.',
    confidence: 'high',
    visible: true,
    reason_if_unclear: null
  };
}

function estimateUsage(imageBytes, question, answerText) {
  const inputTokens = 50 + Math.ceil(imageBytes.length / 750) + Math.ceil((question || '').length / 4);
  const outputTokens = 10 + Math.ceil((answerText || '').length / 4);
  return { inputTokens, outputTokens };
}

async function describe({ imageBytes, mime, question, signal }) {
  if (signal && signal.aborted) {
    state.abortCount++;
    throw makeAbortError();
  }

  state.lastRequest = { imageBytes, mime, question };

  try {
    await sleep(state.delayMs, signal);
  } catch (err) {
    state.abortCount++;
    throw err;
  }

  state.callCount++;

  const scripted = state.queue.shift();

  if (scripted) {
    if (scripted.type === 'error') {
      const err = new Error(scripted.message || 'fake provider error');
      err.isProviderError = true;
      throw err;
    }
    if (scripted.type === 'invalid') {
      return { invalid: true, reason: scripted.reason || 'invalid_json', model: FAKE_MODEL, usage: estimateUsage(imageBytes, question, '') };
    }
    if (scripted.type === 'truncated') {
      return { invalid: true, reason: 'truncated', model: FAKE_MODEL, usage: estimateUsage(imageBytes, question, '') };
    }
    if (scripted.type === 'refused') {
      return { invalid: true, reason: 'provider_refused', model: FAKE_MODEL, usage: estimateUsage(imageBytes, question, '') };
    }
    if (scripted.type === 'valid') {
      return { answer: scripted.answer, model: FAKE_MODEL, usage: estimateUsage(imageBytes, question, scripted.answer.answer) };
    }
  }

  const answer = defaultAnswer(question);
  return { answer, model: FAKE_MODEL, usage: estimateUsage(imageBytes, question, answer.answer) };
}

function assertConfigured() {
  // The fake provider needs no key and makes no network call, by design.
}

module.exports = {
  describe,
  assertConfigured,
  FAKE_MODEL,
  // test control
  reset,
  setNextReply,
  setDelayMs,
  getCallCount,
  getAbortCount,
  getLastRequest
};
