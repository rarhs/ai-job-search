# JobFit — Browser Extension Spec

An MV3 Chrome extension that evaluates any job posting page against your candidate
profile and drafts a tailored cover letter, using your own Anthropic API key.
Ported from this repo's Claude Code skill prompts (`.claude/skills/job-application-assistant/`).

## Product principles

- **BYO API key.** The user's Anthropic key is stored in `chrome.storage.local` and
  only ever sent to the Anthropic API (or a user-configured base URL). No backend,
  no telemetry, no data leaves the browser otherwise.
- **Local-first privacy.** The candidate profile lives in extension storage. Nothing
  is uploaded anywhere except as prompt content to the LLM call the user triggers.
- **Honest scoring.** The fit framework never inflates: gaps are listed, verdicts
  use fixed thresholds, and cover letters follow the "interview backtrack test"
  (no claims the candidate couldn't defend live).

## Architecture

```
extension/
  manifest.json          MV3 manifest
  background.js          Service worker: sole owner of API calls (key never
                         touches page context). Message-passing API.
  lib/prompts.js         Fit-evaluation + cover-letter prompt builders
                         (ported from 04-job-evaluation.md / 03-writing-style.md)
  popup/                 Toolbar UI: extract page → evaluate → draft letter
  options/               Profile, API key, model, advanced: API base URL
  tests/                 Playwright E2E with stubbed Anthropic API
```

Data flow: popup asks `chrome.scripting.executeScript` to extract the job text from
the active tab (activeTab permission — no broad host access to browsing data), builds
a request, sends it to the background worker, which reads the key from storage and
calls `POST {baseUrl}/v1/messages` with `anthropic-dangerous-direct-browser-access: true`.

The fit evaluation asks the model for strict JSON; the popup **recomputes the weighted
overall score client-side** (skills 30%, experience 25%, behavioral 15%, career 30%;
location is pass/fail) so the verdict thresholds are enforced by code, not the model.

Verdict thresholds: 75+ Strong Fit, 60–74 Good Fit, 45–59 Moderate Fit,
30–44 Weak Fit, <30 Poor Fit.

## Work blocks (MVP = blocks 1–5)

Each block ends with its verification step. Do not mark a block done until it passes.

1. ✅ **Core plumbing** — manifest.json, background.js message handler, prompts.js.
   Verify: extension loads in Chromium without manifest errors.
2. ✅ **Options page** — profile textarea, API key field, model select
   (claude-sonnet-5 default / claude-opus-4-8 / claude-haiku-4-5-20251001),
   advanced base-URL override. Verify: values persist across reload.
3. ✅ **Popup: evaluate** — extract job text from active tab, call API, render score
   table, verdict badge, strengths/gaps, recommendation. Handle errors (no key,
   no profile, unparseable page, API error) with actionable messages.
4. ✅ **Popup: cover letter** — after an evaluation, one click drafts a plain-text
   letter in the posting's language following the writing-style rules; copy button.
5. ✅ **E2E test** — Playwright persistent context + `--load-extension`, local fixture
   job page, stub `/v1/messages` server. Asserts the full happy path and the
   no-key error path. This is the self-verification loop for all future work.
6. ✅ *(v0.2)* Job-page auto-detection: `content/detect.js` parses JSON-LD
   `JobPosting` on every http(s) page (purely local, no network) and lights a
   green "JOB" **toolbar action badge** — chosen over an injected on-page badge
   to avoid breaking host pages. E2E covers badge on/off + structured extraction.
7. ✅ *(v0.2)* History: every successful evaluation stored (capped at 50) with
   timestamp, URL, scores and full evaluation JSON; History view in popup
   (newest first), Export JSON download, Clear. E2E covers all of it.
8. ✅ *(v0.2)* Cross-browser builds: `build.mjs` stages `dist/chrome` +
   `dist/firefox` (and zips) — test-only localhost permissions stripped, Firefox
   gets event-page background + gecko id (no polyfill needed: Firefox 121+
   supports promise-style `chrome.*`). E2E verifies both staged manifests.
   Caveat: Firefox runtime is manual smoke-test only (Playwright can't load
   Firefox extensions); host permissions there are opt-in, documented in README.
9. ✅ *(v0.3)* Profile import wizard in options: paste raw CV/LinkedIn text →
   model structures it into markdown profile sections (anti-fabrication rules in
   prompt, "(not stated)" for missing facts) → draft lands in the profile field
   for review; nothing persists until explicit Save. E2E covers the full flow.
10. ✅ *(v0.3)* Streaming + cost: background worker streams SSE over a port,
    the cover letter renders live into the popup; every call shows
    "N in / M out tokens · ~$X" computed from `lib/pricing.js` (sticker
    per-MTok rates cached 2026-06 from Anthropic pricing docs — update there
    when prices change). E2E covers mid-stream partial render, usage math,
    and that the wire request sets stream:true.

## Testing contract

`tests/run-e2e.mjs` must exit 0 with the extension fully driven headlessly:
options saved → fixture page evaluated (stubbed API returns a canned fit JSON) →
score table shows recomputed overall + verdict → letter drafted → copy content
matches stub. Any UI regression must fail this script.

## Store-release checklist (later)

- Remove `http://localhost/*` host permission (test-only).
- Icons, listing screenshots, privacy policy page (can state: no data collection).
- Key handling note: storage.local is unencrypted at rest; document the tradeoff.
