'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  score,
  scoreCase,
  extractYesNo,
  isAbstention,
  classifyAbsentProbeAnswer,
  classifyAbsentProbeTextOnly,
  extractProbedNoun
} = require('../eval/score');

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
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(testCase, { answer: 'I see no cat in this picture.', visible: false });
    assert.equal(result.correct, true);
    assert.equal(result.hallucinated, false);
  });

  await t.test('absent probe: "Yes, a cat" (the draft\'s own example) is a hallucination, not merely wrong', () => {
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
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
    assert.equal(metrics.abstentionRate, 1, 'only the genuine abstention should be in the denominator, not the fallback');
  });

  await t.test('score() reports the three outcomes as independent metrics, not one pass/fail number', () => {
    const cases = [
      { type: 'present', groundTruth: 'red' },
      { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
      { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
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

test('second adversarial review fix: absent-probe negation must apply to the probed noun, not just appear anywhere in the sentence', async (t) => {
  await t.test('extractProbedNoun pulls the single noun out of the standard probe question shape', () => {
    assert.equal(extractProbedNoun('Is there a cat in the image?'), 'cat');
    assert.equal(extractProbedNoun('Is there an elephant in the image?'), 'elephant');
    assert.equal(extractProbedNoun('Is there a red car in the image?'), 'red car');
    assert.equal(extractProbedNoun('something unrelated'), null);
    assert.equal(extractProbedNoun(undefined), null);
  });

  await t.test('"There is a cat, not a dog." on a cat probe is a hallucination: it affirms the probed object despite containing the word "not"', () => {
    // The exact failing case named in the review: the old NEGATION_RE
    // matched "not" anywhere in the sentence and scored this as a correct
    // denial. "not" here negates "dog", an unrelated noun, not the
    // probed "cat", which this sentence actually affirms.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(testCase, { answer: 'There is a cat, not a dog.', visible: true });
    assert.equal(result.hallucinated, true, 'affirming the probed cat must be flagged as a hallucination');
    assert.equal(result.correct, false);
  });

  await t.test('"There is a cat, not a dog." on a dog probe is a correct denial', () => {
    // Same sentence, different probed noun: this time "not" really is
    // right before the probed noun ("dog"), so it is a genuine denial.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a dog in the image?' };
    const result = scoreCase(testCase, { answer: 'There is a cat, not a dog.', visible: false });
    assert.equal(result.correct, true);
    assert.equal(result.hallucinated, false);
  });

  await t.test('"No doubt about it, there is a cat." on a cat probe is a hallucination, not a correct denial', () => {
    // The other exact failing case named in the review: "no" here is part
    // of the idiom "no doubt", nowhere near the probed noun "cat", which
    // the sentence goes on to affirm.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(testCase, { answer: 'No doubt about it, there is a cat.', visible: true });
    assert.equal(result.hallucinated, true);
    assert.equal(result.correct, false);
  });

  await t.test('classifyAbsentProbeAnswer trusts a structured visible:true directly, without parsing text at all', () => {
    // When a structured `visible` flag is present (every fake/graded
    // provider reply has one), it is trusted outright rather than
    // re-derived from prose; this is what lets the two cases above score
    // correctly without any text heuristic even being consulted.
    assert.equal(classifyAbsentProbeAnswer({ answer: 'whatever text, does not matter here', visible: true }, 'cat'), 'yes');
    assert.equal(classifyAbsentProbeAnswer({ answer: 'whatever text, does not matter here', visible: false }, 'cat'), 'no');
  });

  await t.test('classifyAbsentProbeAnswer falls back to the directional text heuristic only when there is no structured visible flag', () => {
    // No `visible` key at all simulates a real free-text model response
    // that never went through this app's own schema validation; this is
    // the documented approximation path, not the primary/exact one.
    assert.equal(classifyAbsentProbeAnswer({ answer: 'There is no cat here.' }, 'cat'), 'no');
    assert.equal(classifyAbsentProbeAnswer({ answer: 'There is a cat, not a dog.' }, 'cat'), 'yes');
    assert.equal(classifyAbsentProbeAnswer({ answer: 'There is a cat, not a dog.' }, 'dog'), 'no');
  });
});

test('second adversarial review fix: an absent-probe answer that never mentions the probed object is not a hallucination', async (t) => {
  await t.test('"I only see a blue textured pattern" on a cat probe is a legitimate description, not a hallucination', () => {
    // The pre-fix classifyAbsentProbeAnswer treated ANY answer with no
    // explicit denial as a hallucination, which overcounted an answer
    // that simply never raises the probed object at all.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(testCase, { answer: 'I only see a blue textured pattern.', visible: false });
    assert.equal(result.hallucinated, false, 'never mentioning the probed object must not count as a hallucination');
  });

  await t.test('classifyAbsentProbeAnswer reports "unmentioned" for this case specifically, distinct from a real denial', () => {
    assert.equal(
      classifyAbsentProbeAnswer({ answer: 'I only see a blue textured pattern.' }, 'cat'),
      'unmentioned'
    );
  });

  await t.test('an absent-probe answer that DOES assert the probed object, with no yes/no word at all, is still a hallucination', () => {
    // "I see a cat on the sofa" never says "yes", but it affirmatively
    // names the probed (absent-by-construction) object instead of
    // denying it, so it must still be flagged.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(testCase, { answer: 'I see a cat on the sofa.', visible: true });
    assert.equal(result.hallucinated, true);
    assert.equal(result.correct, false);
  });
});

test('second adversarial review fix: scoreCase checks the fallback/failure path uniformly, before any outcome classification, for every case type', async (t) => {
  await t.test('a fallback on an absent_probe question is its own bucket, not scored as a hallucination', () => {
    // Before this fix, scoreCase only special-cased schemaValid:false for
    // 'unanswerable'; an absent_probe question given a fallback reply (no
    // mention of the probed noun, visible:false) fell straight into the
    // ordinary classification path and, with the old code, counted as a
    // hallucination via the "no denial = hallucination" overcount bug.
    const testCase = { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' };
    const result = scoreCase(
      testCase,
      { answer: "I couldn't get a clear answer that time. Please try again.", confidence: 'low', visible: false, reason_if_unclear: 'truncated' },
      { schemaValid: false }
    );
    assert.equal(result.fallback, true);
    assert.equal(result.hallucinated, false);
    assert.equal(result.correct, false);
  });

  await t.test('a fallback on a present question is its own bucket, not scored as wrong', () => {
    const testCase = { type: 'present', groundTruth: 'red' };
    const result = scoreCase(
      testCase,
      { answer: "I couldn't get a clear answer that time. Please try again.", visible: false },
      { schemaValid: false }
    );
    assert.equal(result.fallback, true);
    assert.equal(result.correct, false);
  });

  await t.test('score() surfaces a distinct fallbackCount, and excludes fallback cases from the hallucination-rate denominator', () => {
    const cases = [
      { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
      { type: 'absent_probe', groundTruth: 'no', question: 'Is there a dog in the image?' }
    ];
    const responses = [
      { answer: { answer: 'There is no cat here.', visible: false }, schemaValid: true },
      {
        answer: { answer: "I couldn't get a clear answer that time. Please try again.", visible: false },
        schemaValid: false
      }
    ];
    const metrics = score(cases, responses);
    assert.equal(metrics.fallbackCount, 1);
    assert.equal(metrics.hallucinationRate, 0, 'the single real, scored case denied correctly, and the fallback must not dilute this rate');
  });
});

test('third adversarial review fix: the agreement metric must run the text-only heuristic, not compare visible against itself', async (t) => {
  await t.test('classifyAbsentProbeTextOnly ignores the visible flag entirely and reads only the prose', () => {
    // Confirms the text-only function is a genuinely independent read of
    // the text: it must classify "Yes, there is a cat right there." as an
    // affirmation regardless of what visible says, since it never looks
    // at visible at all.
    assert.equal(classifyAbsentProbeTextOnly('Yes, there is a cat right there.', 'cat'), 'yes');
  });

  await t.test(
    'exact counterexample from review: "Yes, there is a cat right there." with visible:false must score as disagreement, not 100% agreement',
    () => {
      // Before this fix, classifyAbsentProbeAnswer(trusting visible first)
      // was fed into the agreement check and compared back against
      // visible itself, so it always matched no matter what the text
      // said. Four of these replies previously scored 100% agreement and
      // 0% hallucination; they must now disagree, and must still count as
      // hallucinated by the ordinary (visible-trusting) classification.
      const cases = [
        { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
        { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
        { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' },
        { type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' }
      ];
      const responses = cases.map(() => ({
        answer: { answer: 'Yes, there is a cat right there.', visible: false },
        schemaValid: true
      }));

      const metrics = score(cases, responses);

      assert.equal(metrics.absentProbeVisibleAgreement, 0, 'the text affirms the cat while visible says false: this must disagree every time');
      // hallucinationRate is computed from classifyAbsentProbeAnswer, which
      // still trusts the structured visible:false flag (the prior round's
      // intentional, unrelated improvement), so these score as a correct
      // denial for that metric even though the prose disagrees with the
      // flag. That disagreement is exactly what absentProbeVisibleAgreement
      // above exists to surface.
      assert.equal(metrics.hallucinationRate, 0, 'the ordinary classification used for hallucinationRate still trusts visible:false and is unaffected by this fix');
    }
  );

  await t.test('a genuine match between text and visible still agrees', () => {
    const cases = [{ type: 'absent_probe', groundTruth: 'no', question: 'Is there a cat in the image?' }];
    const responses = [{ answer: { answer: 'There is no cat here.', visible: false }, schemaValid: true }];
    const metrics = score(cases, responses);
    assert.equal(metrics.absentProbeVisibleAgreement, 1);
  });
});
