'use strict';

// Unit prices live here, and only here: lib/cost.js never hardcodes a
// dollar figure. Verify against the live pricing page before trusting a
// cost number from this file; it was last checked against
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-03.
//
// Prices are per million tokens (MTok), in USD.
const PRICING = {
  'fake-vision-1': { inputPerMTok: 0, outputPerMTok: 0, checkedAt: '2026-11-03', source: 'fake provider, no cost' },
  'claude-haiku-5-5': {
    inputPerMTok: 0.10,
    outputPerMTok: 0.50,
    checkedAt: '2026-11-03',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing (prompts under 100k tokens)'
  }
};

function getPricing(model) {
  return PRICING[model] || null;
}

module.exports = { PRICING, getPricing };
