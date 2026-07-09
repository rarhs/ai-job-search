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
const CANNED_LETTER =
  'Dear Marie Holm,\n\nI am applying for the Senior Data Scientist role. ' +
  'I bring five years of Python forecasting work, demonstrated by production ' +
  'models for regional grid operators.\n\nBest regards';

const seenRequests = [];

function startStub(fixtureHtml) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/job') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(fixtureHtml);
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/messages') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        seenRequests.push({ headers: req.headers, body: parsed });
        const isEvaluation = String(parsed.system).includes('career advisor');
        const text = isEvaluation ? JSON.stringify(CANNED_FIT) : CANNED_LETTER;
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

const fixtureHtml = await readFile(
  path.join(EXT_DIR, 'tests/fixture/job.html'), 'utf8');
const server = await startStub(fixtureHtml);
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
  await options.click('details summary');
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

  const evalRequest = seenRequests.find((r) => String(r.body.system).includes('career advisor'));
  check('API key header sent', evalRequest?.headers['x-api-key'] === 'sk-ant-test-key');
  check('anthropic-version header sent', Boolean(evalRequest?.headers['anthropic-version']));
  check('model from options used', evalRequest?.body.model === 'claude-sonnet-5');
  check('job text reached the API',
    JSON.stringify(evalRequest?.body.messages).includes('Windward Analytics'));

  // --- happy path: cover letter ---
  await popup.click('#draft-letter');
  await popup.waitForSelector('#letter-section:not([hidden])', { timeout: 15000 });
  check('letter rendered from API response',
    (await popup.inputValue('#letter')) === CANNED_LETTER.trim());
  const letterRequest = seenRequests.find((r) => String(r.body.system).includes('cover letters'));
  check('letter prompt includes evaluation JSON',
    JSON.stringify(letterRequest?.body.messages).includes('Kubernetes experience is thin'));
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
