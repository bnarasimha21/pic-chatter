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
const NEGATION_WORD_RE = /^(no|not|never|none)$/;

// How many words immediately before the probed noun count as "negating
// it", for the absent_probe text-heuristic fallback below. Deliberately
// small and deliberately one-directional (only words BEFORE the noun, not
// anywhere in the sentence): "there is no cat" negates "cat" because "no"
// sits right before it, but "there is a cat, not a dog" must NOT be read
// as negating "cat" just because the word "not" occurs somewhere later in
// the same sentence, next to an unrelated noun ("dog").
const NEGATION_WINDOW = 3;

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
// answer is expected to explicitly affirm or deny the groundTruth as a
// whole (not a specific noun inside the sentence), so a plain
// anywhere-in-the-sentence check is the right tool there. absent_probe
// does NOT use this for its negation check (see classifyAbsentProbeAnswer
// below) precisely because that case needs to know *what* is being
// negated, not just whether a negation word occurs somewhere.
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
// Callers must never call this on a fallback response (scoreCase enforces
// that uniformly, see below): a fallback is forced to visible: false and a
// canned "I couldn't get a clear answer" message regardless of what
// actually happened, which would otherwise look exactly like a genuine,
// deliberate abstention.
function isAbstention(response) {
  if (response.visible === false) return true;
  return isAbstentionText(response.answer);
}

// Pulls the single noun being probed for out of an absent_probe question,
// e.g. "Is there a cat in the image?" -> "cat". Every case in
// eval/cases.json follows this "Is there a/an/the <noun> in the image?"
// shape; this is a small, local convenience, not a general parser.
function extractProbedNoun(question) {
  if (!question) return null;
  const withSuffix = /is there (?:an?|the)\s+([a-z][a-z\s]*?)\s+in the image/i.exec(question);
  if (withSuffix) return withSuffix[1].trim().toLowerCase();
  const withoutSuffix = /is there (?:an?|the)\s+([a-z][a-z\s]*?)\s*\??$/i.exec(question.trim());
  return withoutSuffix ? withoutSuffix[1].trim().toLowerCase() : null;
}

// True when a negation word sits within NEGATION_WINDOW words immediately
// BEFORE the probed noun, e.g. "there is no cat" (noun="cat": "no" is one
// word before it) or "I do not see a tree" (noun="tree": "not" is three
// words before it). Directional on purpose: "there is a cat, not a dog"
// must not count as negating "cat" just because "not" appears later in
// the sentence, next to a different noun ("dog").
function negationPrecedesNoun(normalizedText, noun) {
  if (!noun) return false;
  const escapedNoun = noun.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const nounRe = new RegExp(`\\b${escapedNoun}\\b`);
  const match = nounRe.exec(normalizedText);
  if (!match) return false;
  const before = normalizedText.slice(0, match.index).trim();
  if (!before) return false;
  const words = before.split(/\s+/).filter(Boolean);
  const window = words.slice(-NEGATION_WINDOW);
  return window.some((word) => NEGATION_WORD_RE.test(word));
}

// Classifies an absent_probe answer as:
//   'no'         - correctly denies the probed object
//   'yes'        - hallucinated: asserts the probed object is present
//   'abstained'  - a genuine "I can't tell" style non-answer
//   'unmentioned'- never mentions the probed object at all (a legitimate
//                  description of something else actually visible); this
//                  is neither a denial nor a hallucination
//
// Two different signals feed this, in priority order:
//
// 1. A structured `visible` boolean on the response, when present. The
//    fake and graded test providers (and the real schema-validated route,
//    when the provider's own reply validates) always return this; it is
//    the model's own direct claim about whether the probed object is
//    visible, not something re-derived by parsing its prose. Trusting it
//    directly sidesteps the text-parsing pitfalls below entirely, and is
//    exact rather than an approximation.
// 2. Free-text heuristics, used ONLY when no structured `visible` flag is
//    available (e.g. a real provider response that never went through
//    this app's own schema validation). This path is an approximation of
//    intent, not a guarantee: it distinguishes "there is no cat" (a real
//    denial: a negation word sits immediately before the probed noun)
//    from "there is a cat, not a dog" or "no doubt about it, there is a
//    cat" (both affirmations that merely contain the words "not"/"no"
//    somewhere unrelated to the probed noun) by requiring the negation to
//    be positioned right before the noun itself, not just present
//    anywhere in the sentence.
// Text-only classification, ignoring any structured `visible` flag
// entirely. This is the heuristic that decides what the answer's PROSE
// says, independent of what the response's own flag claims. It exists as
// its own function (rather than being inlined into
// classifyAbsentProbeAnswer below) specifically so the agreement metric in
// score() can run it and compare the result against `visible` -- if this
// function also trusted `visible`, the agreement check would just be
// comparing the flag with itself and could never detect a real mismatch
// between the text and the flag (e.g. "Yes, there is a cat right there."
// with visible: false must disagree, not silently inherit `false` from the
// flag it is supposed to be checking).
function classifyAbsentProbeTextOnly(answerText, probedNoun) {
  if (isAbstentionText(answerText)) return 'abstained';

  const text = normalize(answerText);
  const mentionsNoun = probedNoun ? new RegExp(`\\b${probedNoun.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(text) : false;

  if (!mentionsNoun) {
    // The answer never mentions the probed object at all, e.g. "I only
    // see a blue textured pattern" on a cat probe. Treating every answer
    // with no explicit denial as a hallucination (the pre-fix behaviour)
    // overcounted legitimate descriptions of what is actually visible as
    // false claims about an object the answer never even raised.
    return 'unmentioned';
  }

  if (negationPrecedesNoun(text, probedNoun)) return 'no';
  return 'yes';
}

function classifyAbsentProbeAnswer(response, probedNoun) {
  const answerText = (response && response.answer) || '';

  if (response && typeof response.visible === 'boolean') {
    if (response.visible === true) return 'yes';
    if (isAbstentionText(answerText)) return 'abstained';
    return 'no';
  }

  return classifyAbsentProbeTextOnly(answerText, probedNoun);
}

// scoreCase(testCase, response, meta) scores one case. `response` is the
// model's structured answer object ({ answer, confidence, visible,
// reason_if_unclear }), or undefined/null if there is none at all.
//
// meta.schemaValid === false means the system never got a usable reply at
// all (invalid JSON, a truncated response, a provider error, a failed
// schema validation) and substituted its own fallbackAnswer(), which is
// forced to `visible: false` and a canned "I couldn't get a clear answer"
// message regardless of what actually happened upstream. This check runs
// FIRST and uniformly, before any of the three real outcome
// classifications (correct / hallucinate / abstain), for every case type:
// a fallback is its own bucket, never silently folded into "hallucinated"
// (the old bug on absent_probe questions) or "abstained" (what would
// happen if isAbstention() were allowed to see it, since visible:false
// looks exactly like a genuine abstention from the outside).
function scoreCase(testCase, response, meta = {}) {
  if (meta.schemaValid === false) {
    return { correct: false, hallucinated: false, abstained: false, fallback: true };
  }

  const answerText = response && response.answer ? response.answer : '';

  if (testCase.type === 'present') {
    const correct = matchesGroundTruth(answerText, testCase.groundTruth);
    return { correct, fallback: false };
  }

  if (testCase.type === 'position') {
    const said = extractYesNo(answerText);
    const correct = said === testCase.groundTruth;
    return { correct, fallback: false };
  }

  if (testCase.type === 'absent_probe') {
    const probedNoun = extractProbedNoun(testCase.question);
    const classification = classifyAbsentProbeAnswer(response, probedNoun);
    const hallucinated = classification === 'yes';
    const correct = classification === 'no';
    return { correct, hallucinated, fallback: false };
  }

  if (testCase.type === 'unanswerable') {
    const abstained = isAbstention(response || {});
    return { correct: abstained, abstained, fallback: false };
  }

  throw new Error(`Unknown case type: ${testCase.type}`);
}

function score(cases, responses) {
  const byType = {};
  let schemaValidCount = 0;
  let agreementCount = 0;
  let agreementTotal = 0;
  let fallbackCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const response = responses[i] || {};
    const type = testCase.type;

    if (!byType[type]) {
      byType[type] = { n: 0, correct: 0, hallucinated: 0, abstained: 0, fallback: 0 };
    }

    const result = scoreCase(testCase, response.answer, { schemaValid: response.schemaValid });
    byType[type].n++;
    if (result.fallback) {
      byType[type].fallback++;
      fallbackCount++;
    } else {
      if (result.correct) byType[type].correct++;
      if (result.hallucinated) byType[type].hallucinated++;
      if (result.abstained) byType[type].abstained++;
    }

    if (response.schemaValid !== undefined) {
      if (response.schemaValid) schemaValidCount++;
    }

    // Agreement between the model's own `visible: false` flag and an
    // INDEPENDENT, text-only read of the answer's prose (issue 4's
    // addition). This must use classifyAbsentProbeTextOnly, not
    // classifyAbsentProbeAnswer: the latter trusts `visible` when present,
    // so comparing its output back against `visible` would just compare
    // the flag with itself and always "agree", no matter what the text
    // actually says. Skipped for a fallback response, same reasoning as
    // scoreCase above: a fallback's visible:false is a forced placeholder,
    // not the model's own claim, so it cannot "agree" or "disagree" with
    // anything.
    if (type === 'absent_probe' && response.answer && result.fallback !== true) {
      agreementTotal++;
      const probedNoun = extractProbedNoun(testCase.question);
      const saidNo = classifyAbsentProbeTextOnly(response.answer.answer, probedNoun) === 'no';
      const visibleFalse = response.answer.visible === false;
      if (saidNo === visibleFalse) agreementCount++;
    }
  }

  const presentLike = ['present', 'position'].flatMap((t) => (byType[t] ? [byType[t]] : []));
  const presentTotalN = presentLike.reduce((sum, t) => sum + t.n, 0);
  const presentTotalCorrect = presentLike.reduce((sum, t) => sum + t.correct, 0);

  const absent = byType.absent_probe || { n: 0, correct: 0, hallucinated: 0, fallback: 0 };
  const unanswerable = byType.unanswerable || { n: 0, correct: 0, abstained: 0, fallback: 0 };

  // Denominators for hallucination/abstention rates exclude fallback
  // cases: a fallback never had a model assert or deny anything, so it
  // must not dilute (or inflate) a rate that is specifically about what
  // the model claimed.
  const absentScored = absent.n - absent.fallback;
  const unanswerableScored = unanswerable.n - unanswerable.fallback;

  return {
    totalCases: cases.length,
    byType,
    fallbackCount,
    groundedAccuracy: presentTotalN === 0 ? null : presentTotalCorrect / presentTotalN,
    hallucinationRate: absentScored <= 0 ? null : absent.hallucinated / absentScored,
    abstentionRate: unanswerableScored <= 0 ? null : unanswerable.abstained / unanswerableScored,
    schemaValidityRate: responses.length === 0 ? null : schemaValidCount / responses.length,
    absentProbeVisibleAgreement: agreementTotal === 0 ? null : agreementCount / agreementTotal
  };
}

module.exports = {
  score,
  scoreCase,
  extractYesNo,
  isAbstention,
  isAbstentionText,
  classifyAbsentProbeAnswer,
  classifyAbsentProbeTextOnly,
  extractProbedNoun,
  matchesGroundTruth
};
