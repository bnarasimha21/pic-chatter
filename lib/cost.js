'use strict';

const { getPricing } = require('../config/pricing');

// Computes a cost estimate purely from usage and the configured unit price
// for the model that answered. Returns null (not a guess) when the model
// is not in config/pricing.js, so an unpriced model never silently reports
// $0.
function computeCost(model, usage) {
  const pricing = getPricing(model);
  if (!pricing || !usage) return null;
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: 'USD',
    pricedAt: pricing.checkedAt
  };
}

module.exports = { computeCost };
