# PicChatter

A small Express + EJS app for asking a spoken (or typed) question about a
picture and getting a grounded, structured answer read back aloud. It talks
to a pluggable vision provider behind a seam: a deterministic offline fake
by default, or Anthropic's Claude for real answers.

## How it works

1. **Capture**: the browser asks for camera permission (after a consent
   notice, see "Privacy and consent" below) and lets you grab a still frame.
2. **Ask**: by voice (Web Speech API's `SpeechRecognition`, where supported)
   or by typing into the text box that is always available as a fallback.
   Both paths call the exact same client function (`public/js/askClient.js`),
   so there is no separate "voice request" and "text request" shape to
   drift apart; see `test/speech-fallback.test.js`.
3. **Answer**: the server downscales the image if needed, checks it is not
   near-black or near-uniform, and asks the configured vision provider a
   single question. The provider is forced to reply through a structured
   `submit_answer` tool call (`answer`, `confidence`, `visible`,
   `reason_if_unclear`), never free-form text, so the server always has a
   safe shape to work with or fall back from.
4. **Speak**: the answer is read aloud with the browser's own
   `speechSynthesis`, no server-side TTS and no extra network call.

## Provider seam

`VISION_PROVIDER` selects the implementation (`lib/vision.js` dispatches to
`lib/vision/<name>.js`):

- `fake` (default): deterministic, offline, makes no network call. Scripted
  by tests and by the eval runner via `setNextReply()`/`setDelayMs()`. This
  is also what `npm start` uses if you set nothing at all.
- `anthropic`: calls the real Claude API (`@anthropic-ai/sdk`) using a
  forced `tool_choice` so the reply is always the structured shape above.
  Needs `ANTHROPIC_API_KEY`. Pricing and image limits in
  `config/pricing.js` were checked against Anthropic's published docs on
  2026-11-03.

The system prompt lives in exactly one place, `prompts/ask.md`
(`test/prompt-location.test.js` greps the rest of the source tree to make
sure nothing duplicates it). Its rules include never inventing an answer
for something not visible, never identifying a real person from their
face, and explicitly declining any instruction smuggled into the question
field rather than following it (prompt-injection defense; see
`test/structured.test.js`).

## Setup

```bash
npm install
cp .env.example .env   # fill in real values; .env is gitignored
npm start
```

With no configuration at all, `VISION_PROVIDER` defaults to `fake`, so
`npm start` works immediately with zero keys and zero network access. Open
http://localhost:3000.

To use the real provider:

```env
VISION_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key
```

## Testing

```bash
npm test           # node --test, the real app on an OS-assigned port, fake provider
npm run test:e2e   # Playwright; SpeechRecognition/speechSynthesis/getUserMedia are stubbed
```

Everything except the few things that genuinely need a real browser
(`test/e2e/flow.spec.js`) runs through Node's built-in test runner against
the real Express app and a real HTTP request, not an isolated unit mock.
CI (`.github/workflows/ci.yml`) runs the suite on Node 20 and 22, and a
separate browser job runs the Playwright tests on Node 22.

## Privacy and consent (issue 2)

- The page shows a consent notice before the camera or microphone are ever
  requested (`public/js/consent.js`, wired into `views/index.ejs`).
  Declining leaves the camera and mic untouched. The notice names the real
  configured vision provider, the current on/off state of image storage,
  and (when storage is on) the actual retention window in minutes, all
  read live from the server rather than hardcoded in the page.
- Consent is recorded against a fingerprint of those facts, not a bare
  flag. If the server config changes afterwards (storage switched on,
  provider swapped, retention window changed), the stored consent no
  longer matches and the notice is shown again. A "Withdraw consent"
  button is also available once the notice has been accepted; it stops
  the camera, clears the recorded consent, and re-shows the notice.
- The server independently checks a `consent` field sent on every `/ask`
  request and only stores the image when that field says consent was
  given; a direct API call that skips this page entirely has no client
  consent record, so the server's own check is the only thing that gates
  storage in that case, not anything the client claims.
- Image storage is off by default (`STORE_IMAGES=false`). When turned on,
  `lib/storage.js` uploads to a DigitalOcean Spaces / S3-compatible bucket
  under a random key, with no public ACL, and only after the vision call
  for that image has actually completed successfully, never speculatively
  in parallel with it.
- Deletion is scheduled after `STORE_RETENTION_MINUTES` (default 10) via an
  in-memory timer, but that timer does not survive a process restart,
  crash, or redeploy within the retention window. Two more layers back it
  up: a startup sweep (`sweepExpiredOnStartup()`) that deletes anything
  already past its retention window as soon as the process comes back up,
  and a best-effort bucket lifecycle rule (`ensureLifecyclePolicy()`) set
  on startup as a coarse, whole-day-granularity backstop (S3-compatible
  lifecycle rules cannot express a 10 minute window). Failed deletes are
  retried with exponential backoff up to a fixed number of attempts. None
  of this is a guarantee that a photo is deleted within exactly the stated
  window if the process is down the entire time; it is a guarantee that it
  is deleted as soon as the process is next running, plus a same-day
  backstop if it is not.
- Per-IP rate limiting (`express-rate-limit`) and a rolling-window daily
  call cap (`lib/rateLimit.js`) protect the real vision provider from
  abuse; both are env-configured, not hardcoded.
- Server logs record size, mime type (as actually detected from the image
  bytes, not the client-declared `Content-Type`), duration, status, and
  provider name, never the image bytes or the question text.

## Grounding eval (issue 3)

`eval/` is a small, from-scratch evaluation harness, not a benchmark
library. It measures three outcomes separately, not one pass/fail number:

| Metric | What it measures |
|---|---|
| Grounded accuracy | correct answers to questions about things actually in the picture |
| Hallucination rate | confidently answering "yes" to an absent-object probe (POPE-style, Li et al. 2023) |
| Abstention rate | correctly saying "I can't tell" to a question the picture cannot answer |

Images (`eval/images/`) are generated from fixed SVG strings
(`eval/make_images.js`), so ground truth is exact by construction and the
same seed always produces the same bytes (`eval/images.sha256.json`,
checked by `test/eval-images.test.js`). They are simple shapes, text, and
counts, not photographs, and the report says so.

```bash
npm run eval                                  # fake provider, no network, no keys
node eval/run.js --provider anthropic --yes   # real provider; prints a cost estimate and refuses without --yes
```

`test/eval.test.js` runs the real eval against the real `/ask` route inside
`node --test` and asserts the generated report contains every metric.
`.github/workflows/eval.yml` runs the fake eval on every PR, failing the
build if `eval/budgets.json`'s latency/token budgets are exceeded, and
offers a manual `workflow_dispatch` run against the real provider.

## Structured answers (issue 4)

Every answer is validated against `lib/answerSchema.js`'s shape before it
reaches the client. An invalid, truncated, or refused provider reply never
crashes the request or leaks raw provider text: it falls back to a fixed
safe answer (`fallbackAnswer()`) and is logged with a reason, not silently
swallowed. See `test/structured.test.js` for the invalid/truncated/refused
cases, the all-black-frame short-circuit (the provider is never called),
the sentence-boundary truncation of over-length answers, and the
prompt-injection test described above.

## Voice and text UI (issue 5)

Speech input is feature-detected (`window.SpeechRecognition` or
`window.webkitSpeechRecognition`); when it is missing, the mic button
stays hidden and the always-available text box is the only path in, not a
degraded one. A stop button is wired to an `AbortController` that cancels
the in-flight `fetch`, stops active speech recognition, and cancels
speech synthesis, all at once.

All stateful UI logic lives in a framework-free reducer
(`public/js/state.js`), unit-tested directly in Node (`test/reducer.test.js`)
with no DOM needed. The only part that genuinely needs a real browser is
covered by Playwright (`test/e2e/flow.spec.js`), which stubs
`SpeechRecognition`, `speechSynthesis`, and `getUserMedia` and drives the
real page end to end, including the stop button aborting a slow request.

## Latency and cost (issue 6)

Every `/ask` response carries a `Server-Timing` header and a matching
`timing` object in the JSON body (`lib/timing.js`), with marks for
`received`, `preprocess_done`, `provider_first_byte`, `provider_done`, and
`response_sent`. `usage.cost` is computed strictly from `config/pricing.js`
(never hardcoded in the route) and is `null`, not a silent zero, for any
model that is not in that file.

Images are downscaled to `IMAGE_MAX_DIM` (default 1092px longest side,
matching Claude's documented standard image tier) before they reach the
provider or storage, since both latency and input-token cost scale with
image size (`lib/imagePrep.js`, `test/imagePrep.test.js`).

`eval/budgets.json` sets a p95 server-time budget and a max-tokens-per-answer
budget; `eval/budgets.js`'s `checkBudgets()` fails CI if either is
exceeded. The fake provider supports an injected artificial delay
(`setDelayMs()`) specifically so this failure path is itself testable
without waiting on real network latency; see `test/budgets.test.js`.

## Known residual

- `npm audit` reports advisories that trace only to dev-only tooling
  (`nodemon`, used by `npm run dev`), never to a dependency on the
  production start path or the test path. Fixing it would require a
  breaking downgrade of a dev convenience tool with no production
  exposure, so it has been left as is.
- The committed image hash test (`test/eval-images.test.js`) compares exact
  bytes produced by `eval/make_images.js`. If a CI runner ever renders SVG
  to PNG with a different font-rendering stack than the one the hashes
  were committed with, that test could fail on CI without any real bug;
  this is a watch item, not something fixed here.
- `eval/budgets.js`'s latency/cost budget test reads values that are
  hardcoded in the test itself rather than loaded from `eval/budgets.json`,
  so the two can drift. Also, `.github/workflows/eval.yml` only runs the
  eval on pull requests, not on pushes to `main`, so a budget regression
  introduced by a direct push would not be caught by CI.
- There is no `app.set('trust proxy', ...)` configured, so if this app is
  ever deployed behind a single reverse proxy, every request arrives from
  that proxy's address as far as `express-rate-limit` and the daily cap
  are concerned, and all real clients behind it share one rate-limit
  bucket. The daily cap also counts rejected requests (400 for a bad
  upload, 415 for an unsupported type) against the same cap as successful
  calls. Neither is fixed here; both should be addressed before any real
  deployment behind a proxy.

## License

ISC
