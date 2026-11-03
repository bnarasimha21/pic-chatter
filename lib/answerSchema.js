'use strict';

// The structured shape every vision provider must return (issue 4).
// { answer: string, confidence: "high"|"medium"|"low", visible: boolean, reason_if_unclear: string|null }

const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

// JSON schema used to force structured tool output from a provider that
// supports tool calling (see lib/vision/anthropic.js).
const TOOL_NAME = 'submit_answer';

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'The answer to the question, in at most two short sentences.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident the answer is, given what is visible.'
    },
    visible: {
      type: 'boolean',
      description: 'Whether the thing the question asks about is visible in the image.'
    },
    reason_if_unclear: {
      type: ['string', 'null'],
      description: 'If the answer could not be determined, a short reason why (otherwise null).'
    }
  },
  required: ['answer', 'confidence', 'visible', 'reason_if_unclear'],
  additionalProperties: false
};

function isValidAnswer(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (typeof candidate.answer !== 'string' || candidate.answer.length === 0) return false;
  if (!CONFIDENCE_LEVELS.has(candidate.confidence)) return false;
  if (typeof candidate.visible !== 'boolean') return false;
  if (candidate.reason_if_unclear !== null && typeof candidate.reason_if_unclear !== 'string') return false;
  return true;
}

// A fallback used whenever the provider's reply is missing, not valid JSON,
// truncated, or fails validation. Never thrown: the route always has a safe
// answer to hand to the client and to speech.
function fallbackAnswer(reason) {
  return {
    answer: "I couldn't get a clear answer that time. Please try again.",
    confidence: 'low',
    visible: false,
    reason_if_unclear: reason || 'provider_error'
  };
}

module.exports = {
  TOOL_NAME,
  TOOL_INPUT_SCHEMA,
  isValidAnswer,
  fallbackAnswer
};
