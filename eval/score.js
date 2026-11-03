'use strict';

// Rule-based scoring, no judge model. Each case type is scored differently:
//   present      - normalized string/number match against groundTruth
//   absent_probe - yes/no extraction; answering "yes" is a hallucination
//   unanswerable - abstention phrase match, or visible === false
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

function extractYesNo(answerText) {
  const text = normalize(answerText);
  const startsWithNo = /^no\b/.test(text) || /\bno\b,?\s/.test(text) || text.includes('no,') || text.startsWith('no ');
  const startsWithYes = /^yes\b/.test(text) || text.startsWith('yes ') || text.includes('yes,');
  if (startsWithNo && !startsWithYes) return 'no';
  if (startsWithYes && !startsWithNo) return 'yes';
  // Fall back to whichever token appears first.
  const noIdx = text.indexOf('no');
  const yesIdx = text.indexOf('yes');
  if (noIdx === -1 && yesIdx === -1) return null;
  if (noIdx === -1) return 'yes';
  if (yesIdx === -1) return 'no';
  return noIdx < yesIdx ? 'no' : 'yes';
}

function isAbstention(response) {
  if (response.visible === false) return true;
  const text = normalize(response.answer);
  return ABSTENTION_PHRASES.some((phrase) => text.includes(phrase));
}

function scoreCase(testCase, response) {
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
    const said = extractYesNo(answerText);
    const hallucinated = said === 'yes';
    const correct = said === 'no';
    return { correct, hallucinated };
  }

  if (testCase.type === 'unanswerable') {
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

    const result = scoreCase(testCase, response.answer);
    byType[type].n++;
    if (result.correct) byType[type].correct++;
    if (result.hallucinated) byType[type].hallucinated++;
    if (result.abstained) byType[type].abstained++;

    if (response.schemaValid !== undefined) {
      if (response.schemaValid) schemaValidCount++;
    }

    // Agreement between the model's own `visible: false` flag and the
    // absent-object probes' correct answer (issue 4's addition).
    if (type === 'absent_probe' && response.answer) {
      agreementTotal++;
      const saidNo = extractYesNo(response.answer.answer) === 'no';
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

module.exports = { score, scoreCase, extractYesNo, isAbstention, matchesGroundTruth };
