# JobFit — Browser Extension

Evaluate the job posting you're looking at against your candidate profile, get an
honest fit score, and draft a tailored cover letter — powered by your own Anthropic
API key. This is the browser-extension port of this repo's Claude Code application
workflow (same scoring framework and writing rules, see [SPEC.md](SPEC.md)).

## Install (unpacked, Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Click the JobFit icon → **Settings**:
   - Paste your candidate profile (CV text, skills, career goals, location constraints)
   - Paste your Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
   - Pick a model (Claude Sonnet 5 is the default)

## Use

Open any job posting page, click the JobFit toolbar icon, hit **Evaluate this job
posting**. You get a 0–100 score across four weighted dimensions (technical skills
30%, experience 25%, behavioral fit 15%, career alignment 30%) plus a location
pass/fail, strengths, gaps, and an apply/skip recommendation. The overall score and
verdict thresholds are computed in code, not by the model, so they can't be
sweet-talked. One more click drafts a cover letter in the posting's language that
follows strict rules: no clichés, no fabricated claims, forward-looking framing.

## Privacy

No backend, no telemetry. Your profile and API key live in `chrome.storage.local`
and are sent only to `api.anthropic.com` (or the base URL you configure) when you
click a button. Note that extension storage is unencrypted at rest on your machine.

## Development

```
tests/            Playwright E2E with a stubbed Anthropic API
lib/prompts.js    Prompt builders + scoring math (the ported skill logic)
background.js     Service worker — sole owner of API calls
```

Run the E2E suite (requires Node 18+, Playwright's Chromium):

```bash
cd tests && npm install && node run-e2e.mjs
```

The test loads the unpacked extension into Chromium, serves a fixture job posting,
stubs `POST /v1/messages`, and drives the full flow: options → evaluate → letter.
`CHROMIUM_PATH` overrides the browser binary (defaults to `/opt/pw-browsers/chromium`,
falling back is needed on local machines: `npx playwright install chromium` then set
`CHROMIUM_PATH` to the installed binary).

Before a Web Store release, see the checklist in [SPEC.md](SPEC.md) — notably remove
the `http://localhost/*` host permissions, which exist only for the test stub.
