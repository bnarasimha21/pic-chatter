'use strict';

const fs = require('fs');
const path = require('path');
const { TOOL_NAME, TOOL_INPUT_SCHEMA } = require('../answerSchema');

// Real provider: Claude vision + forced tool use for structured output.
// Docs read at implementation time (2026-11-03):
//   - Image content blocks (base64, max 8000x8000 px per image, 5 MB per
//     base64-encoded image): https://platform.claude.com/docs/en/build-with-claude/vision
//   - Forcing a tool call with tool_choice so the model cannot reply in
//     free text: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
//   - Pricing table (checked 2026-11-03): https://platform.claude.com/docs/en/about-claude/pricing
//     claude-haiku-5-5 is $0.10/MTok input, $0.50/MTok output for prompts
//     under 100k tokens, which is why it is the default model here; verify
//     against the live pricing page before trusting eval/budgets numbers.

const DEFAULT_MODEL = 'claude-haiku-5-5';
const PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'ask.md');

let cachedSystemPrompt = null;
function loadSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const raw = fs.readFileSync(PROMPT_PATH, 'utf8');
  // Strip the leading markdown doc-comment (everything up to and including
  // the first "---" line) so only the actual instruction text is sent.
  const marker = '\n---\n';
  const idx = raw.indexOf(marker);
  cachedSystemPrompt = idx === -1 ? raw.trim() : raw.slice(idx + marker.length).trim();
  return cachedSystemPrompt;
}

function assertConfigured() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'VISION_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set. ' +
      'Set it in your environment or .env, or switch VISION_PROVIDER=fake for local use.'
    );
  }
}

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    // Lazily required so the fake provider path never needs this installed
    // or importable without network access.
    // eslint-disable-next-line global-require
    const Anthropic = require('@anthropic-ai/sdk');
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

async function describe({ imageBytes, mime, question, signal }) {
  assertConfigured();
  const client = getClient();
  const model = process.env.VISION_MODEL || DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: loadSystemPrompt(),
    tools: [
      {
        name: TOOL_NAME,
        description: 'Submit the structured answer to the question about the image.',
        input_schema: TOOL_INPUT_SCHEMA
      }
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mime, data: imageBytes.toString('base64') }
          },
          { type: 'text', text: question }
        ]
      }
    ]
  }, { signal });

  const usage = {
    inputTokens: response.usage ? response.usage.input_tokens : null,
    outputTokens: response.usage ? response.usage.output_tokens : null
  };

  if (response.stop_reason === 'max_tokens') {
    return { invalid: true, reason: 'truncated', model, usage };
  }

  const toolUse = (response.content || []).find((block) => block.type === 'tool_use' && block.name === TOOL_NAME);
  if (!toolUse) {
    return { invalid: true, reason: 'provider_refused', model, usage };
  }

  return { answer: toolUse.input, model, usage };
}

module.exports = { describe, assertConfigured, DEFAULT_MODEL, loadSystemPrompt };
