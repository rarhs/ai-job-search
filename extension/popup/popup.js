import {
  buildEvaluationRequest,
  buildCoverLetterRequest,
  computeOverall,
  verdictFor,
  parseModelJson,
} from '../lib/prompts.js';

const $ = (id) => document.getElementById(id);

let lastEvaluation = null;
let lastJobText = null;

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const HISTORY_LIMIT = 50;

async function saveHistoryEntry(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const ul = $('history-list');
  ul.replaceChildren();
  if (!history.length) {
    const li = document.createElement('li');
    li.textContent = 'No evaluations yet.';
    ul.appendChild(li);
    return;
  }
  for (const entry of history) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.textContent =
      `${entry.overall}/100 ${entry.verdict} — ${[entry.role, entry.company].filter(Boolean).join(' at ')}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${new Date(entry.ts).toLocaleString()} · ${entry.url || ''}`;
    li.append(title, meta);
    ul.appendChild(li);
  }
}

$('open-history').addEventListener('click', async (e) => {
  e.preventDefault();
  const section = $('history-section');
  if (section.hidden) await renderHistory();
  section.hidden = !section.hidden;
});

$('export-history').addEventListener('click', async () => {
  const { history = [] } = await chrome.storage.local.get('history');
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jobfit-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('clear-history').addEventListener('click', async () => {
  await chrome.storage.local.remove('history');
  await renderHistory();
});

function setStatus(text, isError = false) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = isError ? 'error' : '';
}

// The popup itself is the active tab when opened as a page (E2E tests do this),
// so fall back to the most recently used normal web tab.
async function findTargetTab() {
  const isWebPage = (tab) => tab.url && /^https?:/.test(tab.url);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isWebPage(active)) return active;
  const all = await chrome.tabs.query({});
  const web = all.filter(isWebPage).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return web[0] || null;
}

// Injected into the page; must be self-contained.
function extractJobText() {
  const tidy = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Prefer structured data when the site provides it.
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
      for (const node of nodes) {
        if (node && String(node['@type']).includes('JobPosting')) {
          const div = document.createElement('div');
          div.innerHTML = node.description || '';
          return tidy([
            `Title: ${node.title || ''}`,
            `Company: ${node.hiringOrganization?.name || ''}`,
            `Location: ${node.jobLocation?.address?.addressLocality || ''}`,
            div.innerText || div.textContent,
          ].join('\n'));
        }
      }
    } catch { /* malformed JSON-LD, fall through */ }
  }

  let best = '';
  for (const sel of ['main', 'article', '[class*="job"]', '#content', '.content']) {
    for (const el of document.querySelectorAll(sel)) {
      const t = el.innerText || '';
      if (t.length > best.length) best = t;
    }
  }
  if (best.length < 200) best = document.body.innerText || '';
  return tidy(document.title + '\n' + best).slice(0, 20000);
}

async function callModel(payload) {
  const res = await chrome.runtime.sendMessage({ type: 'anthropic', payload });
  if (!res) throw new Error('No response from background worker');
  if (!res.ok) {
    if (res.error.includes('NO_API_KEY')) {
      throw new Error('No API key configured. Open Settings and paste your Anthropic API key.');
    }
    throw new Error(res.error.replace('API_ERROR: ', 'API error: '));
  }
  return res.text;
}

const DIMENSION_LABELS = {
  technical_skills: 'Technical skills',
  experience: 'Experience',
  behavioral: 'Behavioral fit',
  career: 'Career alignment',
};

function renderEvaluation(evaluation, overall) {
  $('role-line').textContent = [evaluation.role, evaluation.company].filter(Boolean).join(' at ');

  $('overall').textContent = `${overall}/100`;
  const verdict = verdictFor(overall);
  const verdictEl = $('verdict');
  verdictEl.textContent = verdict;
  verdictEl.className = verdict.split(' ')[0].toLowerCase();

  const tbody = $('scores').querySelector('tbody');
  tbody.replaceChildren();
  const addRow = (label, score, note) => {
    const tr = document.createElement('tr');
    for (const [cls, text] of [['dim', label], ['score', score], ['note', note || '']]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  };
  for (const [dim, label] of Object.entries(DIMENSION_LABELS)) {
    addRow(label, `${evaluation[dim].score}/100`, evaluation[dim].note);
  }
  addRow('Location', evaluation.location?.status || '?', evaluation.location?.note);

  const fill = (id, items) => {
    const ul = $(id);
    ul.replaceChildren();
    for (const item of items || []) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
  };
  fill('strengths', evaluation.strengths);
  fill('gaps', evaluation.gaps?.length ? evaluation.gaps : ['None identified']);
  $('recommendation').textContent = evaluation.recommendation || '';

  $('results').hidden = false;
}

$('evaluate').addEventListener('click', async () => {
  const btn = $('evaluate');
  btn.disabled = true;
  $('results').hidden = true;
  $('letter-section').hidden = true;
  try {
    const { profile } = await chrome.storage.local.get('profile');
    if (!profile?.trim()) {
      throw new Error('No candidate profile configured. Open Settings and paste your profile / CV text.');
    }

    setStatus('Reading job posting from the page…');
    const tab = await findTargetTab();
    if (!tab) throw new Error('No web page tab found. Open the job posting in a tab first.');
    const [{ result: jobText } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobText,
    });
    if (!jobText || jobText.length < 100) {
      throw new Error('Could not extract enough text from this page. Is a job posting open?');
    }
    lastJobText = jobText;

    setStatus('Evaluating fit…');
    const { system, user } = buildEvaluationRequest(profile, jobText);
    const raw = await callModel({ system, user, maxTokens: 1500 });
    const evaluation = parseModelJson(raw);
    const overall = computeOverall(evaluation);
    if (overall === null) throw new Error('Model returned incomplete scores. Try again.');

    lastEvaluation = evaluation;
    setStatus('');
    renderEvaluation(evaluation, overall);
    await saveHistoryEntry({
      ts: Date.now(),
      url: tab.url,
      role: evaluation.role,
      company: evaluation.company,
      overall,
      verdict: verdictFor(overall),
      evaluation,
    });
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

$('draft-letter').addEventListener('click', async () => {
  const btn = $('draft-letter');
  btn.disabled = true;
  try {
    const { profile } = await chrome.storage.local.get('profile');
    setStatus('Drafting cover letter…');
    const { system, user } = buildCoverLetterRequest(profile, lastJobText, lastEvaluation);
    const letter = await callModel({ system, user, maxTokens: 1200 });
    $('letter').value = letter.trim();
    $('letter-section').hidden = false;
    setStatus('');
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

$('copy-letter').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('letter').value);
  $('copy-status').textContent = 'Copied';
  setTimeout(() => { $('copy-status').textContent = ''; }, 1500);
});
