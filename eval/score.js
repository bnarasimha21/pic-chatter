'use strict';

// Rule-based scoring, no judge model. Each case type is scored differently:
//   present      - normalized string/number match against groundTruth
//   absent_probe - presence classification; affirming the absent object is
//                  a hallucination
//   unanswerable - a genuine abstention signal from a schema-valid model
//                  reply, never a system fallback
//   position     - yes/no extraction against groundTruth
//
// score(cases, responses) takes the eval cases (with groundTruth) and a
// parallel array of { answer, schemaValid } results, one per case, and
// returns the full metrics object. responses[i] corresponds to cases[i].

const ABSTENTION_PHRASES = [
  "can't tell", 'cannot tell', 'can not tell', "don't know", 'do not know',
  'not sure', 'unable to determine', 'cannot determine', "i can't tell",
  'no way to tell', 'cannot be determined', "can't be determined",
  'not visible', 'not identifiable', 'not determinable'
];

// Word-boundary negation/affirmation cues, not raw substring matches: a
// substring check on "no" matches inside "not", and a substring check on
// "yes" matches inside "yesterday". \b anchors avoid both.
const NEGATION_RE = /\b(no|not|never|none)\b/;
const AFFIRMATION_RE = /\b(yes|yeah|yep)\b/;

function normalize(str) {
  return String(str || '').trim().toLowerCase().replace(/[.,!?]/g, '');
}

function matchesGroundTruth(answerText, groundTruth) {
  const normalizedAnswer = normalize(answerText);
  const normalizedTruth = normalize(groundTruth);
  if (normalizedAnswer.includes(normalizedTruth)) return true;
  // Numeric ground truth ("4") should also match a spelled-out number.
  const numberWords = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };
  for (const [word, digit] of Object.entries(numberWords)) {
    if (normalizedTruth === digit && normalizedAnswer.includes(word)) return true;
  }
  return false;
}

// Generic yes/no extraction, used for 'position' questions where the
// answer is expected to explicitly affirm or deny. Returns null when
// neither a negation nor an affirmation cue is present; callers decide
// what null means for their case type (see classifyAbsentProbeAnswer for
// why 'absent_probe' does not just treat null as "no evidence either way").
function extractYesNo(answerText) {
  const text = normalize(answerText);
  const negation = NEGATION_RE.exec(text);
  const affirmation = AFFIRMATION_RE.exec(text);
  if (negation && !affirmation) return 'no';
  if (affirmation && !negation) return 'yes';
  if (!negation && !affirmation) return null;
  return negation.index < affirmation.index ? 'no' : 'yes';
}

function isAbstentionText(answerText) {
  const text = normalize(answerText);
  return ABSTENTION_PHRASES.some((phrase) => text.includes(phrase));
}

// True when the response itself (a genuine, schema-valid model reply, not
// a system fallback) constitutes an abstention: either the model's own
// `visible: false` flag, or the text matching a known abstention phrase.
function isAbstention(response) {
  if (response.visible === false) return true;
  return isAbstentionText(response.answer);
}

// Classifies an absent_probe answer as 'no' (correctly denies the probed
// object), 'yes' (hallucinated), or 'abstained'. Unlike extractYesNo, a
// reply with no explicit yes/no/negation cue (e.g. "I see a cat on the
// sofa") is not left unclassified: for a yes/no probe about an object that
// is absent by construction, failing to deny it while still giving a
// substantive, non-abstaining answer is itself a hallucination signal, and
// scoring it as "neither correct nor hallucinated" (the pre-fix behaviour)
// silently under-counted real hallucinations.
function classifyAbsentProbeAnswer(answerText) {
  if (isAbstentionText(answerText)) return 'abstained';
  const yn = extractYesNo(answerText);
  if (yn === 'no') return 'no';
  if (yn === 'yes') return 'yes';
  return 'yes';
}

function scoreCase(testCase, response, meta = {}) {
  const answerText = response && response.answer ? response.answer : '';

  if (testCase.type === 'present') {
    const correct = matchesGroundTruth(answerText, testCase.groundTruth);
    return { correct };
  }

  if (testCase.type === 'position') {
    const said = extractYesNo(answerText);
    const correct = said === testCase.groundTruth;
    return { correct };
  }

  if (testCase.type === 'absent_probe') {
    const classification = classifyAbsentProbeAnswer(answerText);
    const hallucinated = classification === 'yes';
    const correct = classification === 'no';
    return { correct, hallucinated };
  }

  if (testCase.type === 'unanswerable') {
    // A system fallback (invalid JSON, truncated, refused, or any other
    // provider reply that failed answerSchema validation) is forced to
    // visible: false by fallbackAnswer() regardless of what actually
    // happened; that is a failure to get an answer, not the model
    // abstaining. Counting it as a correct abstention (the pre-fix
    // behaviour, since isAbstention() alone cannot tell the two apart)
    // meant every failed call inflated the abstention rate to look like a
    // deliberate, correct "I can't tell" instead of a dropped answer.
    if (meta.schemaValid === false) {
      return { correct: false, abstained: false, fallback: true };
    }
    const abstained = isAbstention(response || {});
    return { correct: abstained, abstained };
  }

  throw new Error(`Unknown case type: ${testCase.type}`);
}

function score(cases, responses) {
  const byType = {};
  let schemaValidCount = 0;
  let agreementCount = 0;
  let agreementTotal = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const response = responses[i] || {};
    const type = testCase.type;

    if (!byType[type]) {
      byType[type] = { n: 0, correct: 0, hallucinated: 0, abstained: 0 };
    }

    const result = scoreCase(testCase, response.answer, { schemaValid: response.schemaValid });
    byType[type].n++;
    if (result.correct) byType[type].correct++;
    if (result.hallucinated) byType[type].hallucinated++;
    if (result.abstained) byType[type].abstained++;

    if (response.schemaValid !== undefined) {
      if (response.schemaValid) schemaValidCount++;
    }

    // Agreement between the model's own `visible: false` flag and the
    // absent-object probes' correct answer (issue 4's addition). Uses the
    // same classifier as the hallucination check above so "no explicit
    // yes/no word, but a substantive, non-denying answer" counts as
    // agreeing with visible:true, consistent with how it is scored as a
    // hallucination above, rather than silently coercing to false via
    // `null === 'no'`.
    if (type === 'absent_probe' && response.answer) {
      agreementTotal++;
      const saidNo = classifyAbsentProbeAnswer(response.answer.answer) === 'no';
      const visibleFalse = response.answer.visible === false;
      if (saidNo === visibleFalse) agreementCount++;
    }
  }

  const presentLike = ['present', 'position'].flatMap((t) => (byType[t] ? [byType[t]] : []));
  const presentTotalN = presentLike.reduce((sum, t) => sum + t.n, 0);
  const presentTotalCorrect = presentLike.reduce((sum, t) => sum + t.correct, 0);

  const absent = byType.absent_probe || { n: 0, correct: 0, hallucinated: 0 };
  const unanswerable = byType.unanswerable || { n: 0, correct: 0, abstained: 0 };

  return {
    totalCases: cases.length,
    byType,
    groundedAccuracy: presentTotalN === 0 ? null : presentTotalCorrect / presentTotalN,
    hallucinationRate: absent.n === 0 ? null : absent.hallucinated / absent.n,
    abstentionRate: unanswerable.n === 0 ? null : unanswerable.abstained / unanswerable.n,
    schemaValidityRate: responses.length === 0 ? null : schemaValidCount / responses.length,
    absentProbeVisibleAgreement: agreementTotal === 0 ? null : agreementCount / agreementTotal
  };
}

module.exports = { score, scoreCase, extractYesNo, isAbstention, isAbstentionText, classifyAbsentProbeAnswer, matchesGroundTruth };
