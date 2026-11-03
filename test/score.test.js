'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { score, scoreCase, extractYesNo, isAbstention, classifyAbsentProbeAnswer } = require('../eval/score');

test('issue 3: scorer distinguishes correct-from-picture, hallucination, and correct-abstention as separate metrics', async (t) => {
  await t.test('present case: a correct answer scores correct', () => {
    const testCase = { type: 'present', groundTruth: 'red' };
    const result = scoreCase(testCase, { answer: 'The square is red.' });
    assert.equal(result.correct, true);
  });

  await t.test('present case: a wrong answer scores incorrect', () => {
    const testCase = { type: 'present', groundTruth: 'red' };
    const result = scoreCase(testCase, { answer: 'The square is blue.' });
    assert.equal(result.correct, false);
  });

  await t.test('absent probe: "I see no cat" (the draft\'s own example) is correct and not a hallucination', () => {
    const testCase = { type: 'absent_probe', groundTruth: 'no' };
    const result = scoreCase(testCase, { answer: 'I see no cat in this picture.', visible: false });
    assert.equal(result.correct, true);
    assert.equal(result.hallucinated, false);
  });

  await t.test('absent probe: "Yes, a cat" (the draft\'s own example) is a hallucination, not merely wrong', () => {
    const testCase = { type: 'absent_probe', groundTruth: 'no' };
    const result = scoreCase(testCase, { answer: 'Yes, there is a cat sitting there.', visible: true });
    assert.equal(result.correct, false);
    assert.equal(result.hallucinated, true);
  });

  await t.test('unanswerable: an abstention phrase counts as correct abstention', () => {
    const testCase = { type: 'unanswerable', groundTruth: 'cannot_tell' };
    const result = scoreCase(testCase, { answer: "I can't tell who that is from the picture.", visible: false });
    assert.equal(result.correct, true);
    assert.equal(result.abstained, true);
  });

  await t.test('unanswerable: inventing a confident answer instead of abstaining counts as incorrect, not abstained', () => {
    const testCase = { type: 'unanswerable', groundTruth: 'cannot_tell' };
    const result = scoreCase(testCase, { answer: 'That is John Smith.', visible: true });
    assert.equal(result.correct, false);
    assert.equal(result.abstained, false);
  });

  await t.test('isAbstention treats visible:false as abstention even without an abstention phrase', () => {
    assert.equal(isAbstention({ answer: 'Nothing useful to report.', visible: false }), true);
  });

  await t.test('extractYesNo prefers whichever of yes/no appears first when both are present', () => {
    assert.equal(extractYesNo('No, I do not see a yes answer anywhere'), 'no');
  });

  await t.test('issue review fix: an absent-probe answer with no literal yes/no still counts as a hallucination', () => {
    // "I see a cat on the sofa" never says "yes", but it affirmatively
    // describes the probed (absent-by-construction) object instead of
    // denying it. The pre-fix extractYesNo() returned null for this, which
    // scored it as neither correct nor hallucinated, silently hiding it.
    const testCase = { type: 'absent_probe', groundTruth: 'no' };
    const result = scoreCase(testCase, { answer: 'I see a cat on the sofa.', visible: true });
    assert.equal(result.hallucinated, true);
    assert.equal(result.correct, false);
    assert.equal(classifyAbsentProbeAnswer('I see a cat on the sofa.'), 'yes');
  });

  await t.test('issue review fix: "not" is matched as a real negation word, not an accidental substring of "no"', () => {
    // The pre-fix code used text.indexOf('no'), which matches inside "not"
    // by coincidence. This checks the same outcome now comes from a
    // deliberate word-boundary negation match, by also checking a phrase
    // where the substring trick would have given the wrong answer: "not" is
    // the only negation cue, "no" never appears as its own word here.
    const testCase = { type: 'absent_probe', groundTruth: 'no' };
    const result = scoreCase(testCase, { answer: 'There is a cat, not a dog.', visible: true });
    assert.equal(result.correct, true, 'denying the probed dog should score correct');
    assert.equal(result.hallucinated, false);
    assert.equal(extractYesNo('There is a cat, not a dog.'), 'no');
  });

  await t.test('issue review fix: "yes" is not matched as a substring of "yesterday"', () => {
    assert.equal(extractYesNo('This photo was taken yesterday.'), null);
  });

  await t.test('issue review fix: a system fallback (schemaValid:false) is never scored as a correct abstention', () => {
    // fallbackAnswer() always sets visible:false and a generic "I couldn't
    // get a clear answer" text, regardless of what actually went wrong.
    // Scoring that as abstention makes every dropped/invalid reply look
    // like the model deliberately and correctly declining to answer.
    const testCase = { type: 'unanswerable', groundTruth: 'cannot_tell' };
    const result = scoreCase(
      testCase,
      { answer: "I couldn't get a clear answer that time. Please try again.", confidence: 'low', visible: false, reason_if_unclear: 'truncated' },
      { schemaValid: false }
    );
    assert.equal(result.abstained, false);
    assert.equal(result.correct, false);
    assert.equal(result.fallback, true);
  });

  await t.test('issue review fix: score() keeps fallback replies out of the abstention rate', () => {
    const cases = [
      { type: 'unanswerable', groundTruth: 'cannot_tell' },
      { type: 'unanswerable', groundTruth: 'cannot_tell' }
    ];
    const responses = [
      { answer: { answer: "I can't tell who that is.", visible: false }, schemaValid: true },
      { answer: { answer: "I couldn't get a clear answer that time. Please try again.", visible: false }, schemaValid: false }
    ];
    const metrics = score(cases, responses);
    assert.equal(metrics.abstentionRate, 0.5, 'only the genuine abstention should count, not the fallback');
  });

  await t.test('score() reports the three outcomes as independent metrics, not one pass/fail number', () => {
    const cases = [
      { type: 'present', groundTruth: 'red' },
      { type: 'absent_probe', groundTruth: 'no' },
      { type: 'absent_probe', groundTruth: 'no' },
      { type: 'unanswerable', groundTruth: 'cannot_tell' }
    ];
    const responses = [
      { answer: { answer: 'The square is red.', visible: true }, schemaValid: true },
      { answer: { answer: 'I see no cat in this picture.', visible: false }, schemaValid: true },
      { answer: { answer: 'Yes, there is a cat sitting there.', visible: true }, schemaValid: true },
      { answer: { answer: "I can't tell who that is.", visible: false }, schemaValid: true }
    ];

    const metrics = score(cases, responses);
    assert.equal(metrics.groundedAccuracy, 1);
    assert.equal(metrics.hallucinationRate, 0.5);
    assert.equal(metrics.abstentionRate, 1);
    assert.equal(metrics.schemaValidityRate, 1);
    // These three must be distinct numbers, not a single aggregate pass rate.
    const distinctValues = new Set([metrics.groundedAccuracy, metrics.hallucinationRate, metrics.abstentionRate]);
    assert.ok(distinctValues.size >= 2, 'the three outcome metrics should be measured independently');
  });
});
