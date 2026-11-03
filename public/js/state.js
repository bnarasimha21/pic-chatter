(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PicChatterState = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure state machine for the voice/text UI (issue 5). No DOM, no timers,
  // no network: index.ejs calls reduce(state, action) and renders whatever
  // state comes back. Kept in its own module so it can be unit tested
  // directly from Node without a browser.
  //
  // States:
  //   idle      - waiting for the user to start
  //   listening - mic is capturing speech (voice path only)
  //   asking    - a request to /ask is in flight
  //   speaking  - the answer is being read aloud
  //   error     - something failed; waiting for the user to acknowledge
  //
  // STOP always returns to idle from any state: that is the stop button's
  // contract, and it is what lets an in-flight /ask be aborted from any
  // point in the flow.

  const INITIAL_STATE = 'idle';

  const TRANSITIONS = {
    idle: {
      START_LISTEN: 'listening',
      ASK_START: 'asking' // text-input fallback skips straight to asking
    },
    listening: {
      SPEECH_RESULT: 'asking',
      ASK_ERROR: 'error',
      STOP: 'idle'
    },
    asking: {
      ASK_SUCCESS: 'speaking',
      ASK_ERROR: 'error',
      STOP: 'idle'
    },
    speaking: {
      SPEAK_END: 'idle',
      STOP: 'idle'
    },
    error: {
      RESET: 'idle',
      STOP: 'idle'
    }
  };

  // STOP is valid from every state, including idle (a no-op stop is fine).
  for (const state of Object.keys(TRANSITIONS)) {
    if (!('STOP' in TRANSITIONS[state])) TRANSITIONS[state].STOP = 'idle';
  }

  // reduce(state, action) -> next state name.
  // An action with no transition defined for the current state is a no-op:
  // it returns the same state unchanged rather than throwing, since a race
  // (for example a late SPEAK_END after the user already hit stop) should
  // not crash the UI.
  function reduce(state, action) {
    const row = TRANSITIONS[state];
    if (!row) return state;
    const next = row[action.type];
    return next || state;
  }

  function isValidState(state) {
    return Object.prototype.hasOwnProperty.call(TRANSITIONS, state);
  }

  return { INITIAL_STATE, reduce, isValidState, TRANSITIONS };
}));
