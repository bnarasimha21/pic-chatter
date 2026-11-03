'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { INITIAL_STATE, reduce, isValidState } = require('../public/js/state');

test('issue 5: the UI state machine is a pure reducer', async (t) => {
  await t.test('starts idle', () => {
    assert.equal(INITIAL_STATE, 'idle');
  });

  await t.test('the full voice happy path: idle -> listening -> asking -> speaking -> idle', () => {
    let state = INITIAL_STATE;
    state = reduce(state, { type: 'START_LISTEN' });
    assert.equal(state, 'listening');
    state = reduce(state, { type: 'SPEECH_RESULT' });
    assert.equal(state, 'asking');
    state = reduce(state, { type: 'ASK_SUCCESS' });
    assert.equal(state, 'speaking');
    state = reduce(state, { type: 'SPEAK_END' });
    assert.equal(state, 'idle');
  });

  await t.test('the text-input fallback path skips listening entirely: idle -> asking -> speaking -> idle', () => {
    let state = INITIAL_STATE;
    state = reduce(state, { type: 'ASK_START' });
    assert.equal(state, 'asking');
    state = reduce(state, { type: 'ASK_SUCCESS' });
    assert.equal(state, 'speaking');
    state = reduce(state, { type: 'SPEAK_END' });
    assert.equal(state, 'idle');
  });

  await t.test('an ask error from asking goes to error, not speaking', () => {
    let state = reduce('asking', { type: 'ASK_ERROR' });
    assert.equal(state, 'error');
  });

  await t.test('RESET from error returns to idle', () => {
    assert.equal(reduce('error', { type: 'RESET' }), 'idle');
  });

  await t.test('STOP returns to idle from every state, including mid-ask and mid-speech', () => {
    for (const state of ['idle', 'listening', 'asking', 'speaking', 'error']) {
      assert.equal(reduce(state, { type: 'STOP' }), 'idle', `STOP from ${state} should go to idle`);
    }
  });

  await t.test('an action with no transition for the current state is a no-op', () => {
    assert.equal(reduce('idle', { type: 'SPEAK_END' }), 'idle');
    assert.equal(reduce('speaking', { type: 'START_LISTEN' }), 'speaking');
  });

  await t.test('isValidState recognizes the five defined states and rejects garbage', () => {
    for (const state of ['idle', 'listening', 'asking', 'speaking', 'error']) {
      assert.equal(isValidState(state), true);
    }
    assert.equal(isValidState('bogus'), false);
  });
});
