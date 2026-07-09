// E2E: loads the unpacked extension in Chromium, drives options -> evaluate ->
// cover letter against a stubbed Anthropic API. Exits 0 only if every
// assertion passes. See SPEC.md "Testing contract".
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANNED_FIT = {
  role: 'Senior Data Scientist',
  company: 'Windward Analytics',
  technical_skills: { score: 82, note: 'Python/ML core match, MLOps gap' },
  experience: { score: 70, note: 'Related forecasting work, less production ML' },
  behavioral: { score: 75, note: 'Cross-functional collaboration matches profile' },
  career: { score: 80, note: 'Directly on stated energy/ML path' },
  location: { status: 'PASS', note: 'Copenhagen hybrid within range' },
  strengths: ['Time-series modelling depth', 'Domain knowledge in energy'],
  gaps: ['Kubernetes experience is thin'],
  recommendation: 'Apply; address the MLOps gap in the cover letter.',
};
// weighted: 82*.30 + 70*.25 + 75*.15 + 80*.30 = 77.35 -> 77 -> Strong Fit
const EXPECTED_OVERALL = '77/100';
const EXPECTED_VERDICT = 'Strong Fit';

const CANNED_FIT_JSONLD = {
  ...CANNED_FIT,
  role: 'Machine Learning Engineer',
  company: 'Nordlys Energy',
  technical_skills: { score: 90, note: 'Time-series forecasting is a direct match' },
  experience: { score: 85, note: 'Same domain, same stack' },
  behavioral: { score: 80, note: 'Operator-facing communication matches' },
  career: { score: 90, note: 'Exactly the stated direction' },
};
// weighted: 90*.30 + 85*.25 + 80*.15 + 90*.30 = 87.25 -> 87 -> Strong Fit
const EXPECTED_JSONLD_OVERALL = 87;
const CANNED_LETTER =
  'Dear Marie Holm,\n\nI am applying for the Senior Data Scientist role. ' +
  'I bring five years of Python forecasting work, demonstrated by production ' +
  'models for regional grid operators.\n\nBest regards';

const CANNED_PROFILE = [
  '## Identity',
  '- Name: Astrid Beck · Aalborg, Denmark · no relocation (not stated: commute radius)',
  '## Experience',
  '- Data Analyst, Fjord Analytics (2021-2025): built churn models in Python',
  '## Skills',
  '- Primary: Python, SQL · Secondary: R, Tableau',
].join('\n');

const STUB_INPUT_TOKENS = 1234;
const STUB_OUTPUT_TOKENS = 567;
// claude-sonnet-5 sticker pricing: (1234*3 + 567*15) / 1e6 = 0.0122
const EXPECTED_COST = '~$0.0122';

const seenRequests = [];

function startStub(fixtures) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && fixtures[req.url]) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(fixtures[req.url]);
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/messages') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        seenRequests.push({ headers: req.headers, body: parsed });
        const system = String(parsed.system);
        const forJsonldPage = JSON.stringify(parsed.messages).includes('Nordlys Energy');
        let text;
        if (system.includes('CV importer')) text = CANNED_PROFILE;
        else if (system.includes('career advisor')) {
          text = JSON.stringify(forJsonldPage ? CANNED_FIT_JSONLD : CANNED_FIT);
        } else text = CANNED_LETTER;

        if (parsed.stream) {
          // Minimal Messages API SSE: usage in message_start / message_delta,
          // text in three spaced-out deltas so the client's live render is testable.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          send({ type: 'message_start', message: { usage: { input_tokens: STUB_INPUT_TOKENS } } });
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          const third = Math.ceil(text.length / 3);
          const chunks = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)];
          send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[0] } });
          for (const [i, chunk] of [...chunks.entries()].slice(1)) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
            if (i === chunks.length - 1) {
              send({ type: 'message_delta', usage: { output_tokens: STUB_OUTPUT_TOKENS } });
              send({ type: 'message_stop' });
            }
          }
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fixtures = {
  '/job': await readFile(path.join(EXT_DIR, 'tests/fixture/job.html'), 'utf8'),
  '/job-jsonld': await readFile(path.join(EXT_DIR, 'tests/fixture/job-jsonld.html'), 'utf8'),
};
const server = await startStub(fixtures);
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`stub server on ${baseUrl}`);

const userDataDir = await mkdtemp(path.join(tmpdir(), 'jobfit-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  // Full Chromium (not headless-shell): extensions need it, and this path is
  // stable across Playwright versions in CI images that pre-install browsers.
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(worker.url()).host;
  console.log(`extension loaded: ${extId}`);

  // --- error path: no profile configured ---
  const jobPage = await context.newPage();
  await jobPage.goto(`${baseUrl}/job`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.click('#evaluate');
  await popup.waitForSelector('#status.error', { timeout: 5000 });
  check('no-profile error shown',
    (await popup.textContent('#status')).includes('No candidate profile'));

  // --- configure options ---
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options/options.html`);
  await options.fill('#profile',
    'MSc Geophysics. 5 years Python ML for energy forecasting (pandas, scikit-learn, ' +
    'PyTorch). Built production wind-power forecast models. Based in Copenhagen, no ' +
    'relocation. Goal: senior ML role in renewable energy.');
  await options.fill('#api-key', 'sk-ant-test-key');
  await options.selectOption('#model', 'claude-sonnet-5');
  await options.click('#advanced summary');
  await options.fill('#base-url', baseUrl);
  await options.click('#save');
  await options.waitForFunction(
    () => document.getElementById('saved-status').textContent === 'Saved');
  await options.reload();
  check('options persist across reload',
    (await options.inputValue('#api-key')) === 'sk-ant-test-key');
  await options.close();

  // --- happy path: evaluate ---
  await jobPage.bringToFront(); // make the job tab the most recently accessed web tab
  await popup.bringToFront();
  await popup.click('#evaluate');
  await popup.waitForSelector('#results:not([hidden])', { timeout: 15000 });

  check('overall recomputed client-side',
    (await popup.textContent('#overall')) === EXPECTED_OVERALL,
    `got "${await popup.textContent('#overall')}"`);
  check('verdict from thresholds',
    (await popup.textContent('#verdict')) === EXPECTED_VERDICT);
  check('role line rendered',
    (await popup.textContent('#role-line')) === 'Senior Data Scientist at Windward Analytics');
  check('five score rows',
    (await popup.locator('#scores tbody tr').count()) === 5);
  check('gap listed',
    (await popup.textContent('#gaps')).includes('Kubernetes'));

  check('evaluation shows token usage and cost',
    (await popup.textContent('#eval-usage')) === `1,234 in / 567 out tokens · ${EXPECTED_COST}`,
    `got "${await popup.textContent('#eval-usage')}"`);

  const evalRequest = seenRequests.find((r) => String(r.body.system).includes('career advisor'));
  check('API key header sent', evalRequest?.headers['x-api-key'] === 'sk-ant-test-key');
  check('anthropic-version header sent', Boolean(evalRequest?.headers['anthropic-version']));
  check('model from options used', evalRequest?.body.model === 'claude-sonnet-5');
  check('job text reached the API',
    JSON.stringify(evalRequest?.body.messages).includes('Windward Analytics'));

  // --- happy path: cover letter (streamed) ---
  await popup.click('#draft-letter');
  await popup.waitForSelector('#letter-section:not([hidden])', { timeout: 15000 });

  // The stub spaces deltas 400ms apart; catch the textarea mid-stream.
  let sawPartial = false;
  const fullLetter = CANNED_LETTER.trim();
  for (let i = 0; i < 40 && !sawPartial; i += 1) {
    const value = await popup.inputValue('#letter');
    if (value.length > 0 && value.length < fullLetter.length) sawPartial = true;
    else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check('letter streams incrementally into the textarea', sawPartial);

  await popup.waitForFunction((expected) =>
    document.getElementById('letter').value === expected, fullLetter, { timeout: 15000 });
  check('letter rendered from API response',
    (await popup.inputValue('#letter')) === fullLetter);
  check('letter shows token usage and cost',
    (await popup.textContent('#letter-usage')) === `1,234 in / 567 out tokens · ${EXPECTED_COST}`);
  check('letter request used streaming',
    seenRequests.find((r) => String(r.body.system).includes('cover letters'))?.body.stream === true);
  const letterRequest = seenRequests.find((r) => String(r.body.system).includes('cover letters'));
  check('letter prompt includes evaluation JSON',
    JSON.stringify(letterRequest?.body.messages).includes('Kubernetes experience is thin'));

  // --- block 6: JSON-LD auto-detection badge + structured extraction ---
  const jsonldPage = await context.newPage();
  await jsonldPage.goto(`${baseUrl}/job-jsonld`);

  const badgeFor = (suffix) => worker.evaluate(async (sfx) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').endsWith(sfx));
    return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : null;
  }, suffix);

  let badge = '';
  for (let i = 0; i < 40 && badge !== 'JOB'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    badge = await badgeFor('/job-jsonld');
  }
  check('badge lights up on JSON-LD job page', badge === 'JOB');
  check('no badge on page without JSON-LD', (await badgeFor('/job')) === '');

  // Evaluate on the JSON-LD page: extraction must use the structured data,
  // not the (deliberately sparse) page body.
  const evalCountBefore = seenRequests.length;
  await jsonldPage.bringToFront();
  await popup.bringToFront();
  await popup.click('#evaluate');
  await popup.waitForSelector('#results:not([hidden])', { timeout: 15000 });
  const jsonldEval = seenRequests
    .slice(evalCountBefore)
    .find((r) => String(r.body.system).includes('career advisor'));
  const sentText = JSON.stringify(jsonldEval?.body.messages);
  check('JSON-LD extraction used (title)', sentText.includes('Machine Learning Engineer'));
  check('JSON-LD extraction used (company)', sentText.includes('Nordlys Energy'));
  check('JSON-LD description HTML stripped', !sentText.includes('<p>'));

  // --- block 7: evaluation history + export ---
  await popup.click('#open-history');
  await popup.waitForSelector('#history-section:not([hidden])', { timeout: 5000 });
  const items = popup.locator('#history-list li');
  check('two history entries after two evaluations', (await items.count()) === 2);
  check('newest entry first',
    (await items.nth(0).textContent()).includes(
      `${EXPECTED_JSONLD_OVERALL}/100 Strong Fit — Machine Learning Engineer at Nordlys Energy`));
  check('older entry second',
    (await items.nth(1).textContent()).includes('Senior Data Scientist at Windward Analytics'));
  check('entry records source URL',
    (await items.nth(0).textContent()).includes('/job-jsonld'));

  const [download] = await Promise.all([
    popup.waitForEvent('download', { timeout: 5000 }),
    popup.click('#export-history'),
  ]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  check('export contains both entries with full evaluations',
    exported.length === 2 &&
    exported[0].overall === EXPECTED_JSONLD_OVERALL &&
    exported[0].evaluation?.technical_skills?.score === 90 &&
    exported[1].overall === 77);

  await popup.click('#clear-history');
  await popup.waitForFunction(() =>
    document.querySelector('#history-list').textContent.includes('No evaluations yet'));
  const { historyAfterClear } = await worker.evaluate(async () => ({
    historyAfterClear: (await chrome.storage.local.get('history')).history ?? null,
  }));
  check('clear empties storage', historyAfterClear === null);

  // --- block 8: cross-browser store builds ---
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('node', [path.join(EXT_DIR, 'build.mjs')]);

  const distManifest = async (browser) =>
    JSON.parse(await readFile(path.join(EXT_DIR, 'dist', browser, 'manifest.json'), 'utf8'));
  const chromeDist = await distManifest('chrome');
  const firefoxDist = await distManifest('firefox');

  check('chrome build drops test-only host permissions',
    chromeDist.host_permissions.every((p) => !p.includes('localhost') && !p.includes('127.0.0.1')) &&
    chromeDist.host_permissions.includes('https://api.anthropic.com/*'));
  check('chrome build keeps service worker background',
    chromeDist.background.service_worker === 'background.js' && !chromeDist.browser_specific_settings);
  check('firefox build uses event-page background',
    JSON.stringify(firefoxDist.background) === JSON.stringify({ scripts: ['background.js'] }));
  check('firefox build has gecko id and no test permissions',
    firefoxDist.browser_specific_settings?.gecko?.id === 'jobfit@ai-job-search' &&
    firefoxDist.host_permissions.every((p) => !p.includes('127.0.0.1') && !p.includes('localhost')));

  const staged = await Promise.all(
    ['popup/popup.html', 'options/options.js', 'content/detect.js', 'lib/prompts.js', 'background.js']
      .flatMap((f) => ['chrome', 'firefox'].map((b) =>
        readFile(path.join(EXT_DIR, 'dist', b, f), 'utf8').then(() => true, () => false))));
  check('all shipped files staged in both builds', staged.every(Boolean));
  check('test fixtures not shipped',
    await readFile(path.join(EXT_DIR, 'dist/chrome/tests/run-e2e.mjs'), 'utf8').then(() => false, () => true));

  // --- block 9: profile import wizard ---
  const options2 = await context.newPage();
  await options2.goto(`chrome-extension://${extId}/options/options.html`);
  const savedProfileBefore = await options2.inputValue('#profile');

  await options2.click('#import-wizard summary');
  await options2.fill('#import-source',
    'Astrid Beck, Aalborg. Data Analyst at Fjord Analytics 2021-2025, built churn ' +
    'prediction models in Python and SQL dashboards for retention team. MSc Economics. ' +
    'Comfortable with R and Tableau. Looking for senior analytics roles, no relocation.');
  await options2.click('#import-run');
  await options2.waitForFunction(() =>
    document.getElementById('import-status').textContent.includes('Draft ready'));

  check('import wizard fills profile with structured draft',
    (await options2.inputValue('#profile')) === CANNED_PROFILE);
  const importRequest = seenRequests.find((r) => String(r.body.system).includes('CV importer'));
  check('raw CV text sent for structuring',
    JSON.stringify(importRequest?.body.messages).includes('churn prediction models'));
  check('import anti-fabrication rule in prompt',
    String(importRequest?.body.system).includes('never invent or embellish'));

  const { profile: storedAfterImport } = await worker.evaluate(
    () => chrome.storage.local.get('profile'));
  check('draft not auto-saved (review-then-save)', storedAfterImport === savedProfileBefore);

  await options2.click('#save');
  await options2.waitForFunction(
    () => document.getElementById('saved-status').textContent === 'Saved');
  const { profile: storedAfterSave } = await worker.evaluate(
    () => chrome.storage.local.get('profile'));
  check('explicit save persists the draft', storedAfterSave === CANNED_PROFILE);
  await options2.close();
} finally {
  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll E2E assertions passed');
