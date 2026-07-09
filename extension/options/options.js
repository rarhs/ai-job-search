import { buildProfileImportRequest } from '../lib/prompts.js';

const $ = (id) => document.getElementById(id);

const FIELDS = {
  profile: 'profile',
  apiKey: 'api-key',
  model: 'model',
  baseUrl: 'base-url',
};

async function load() {
  const stored = await chrome.storage.local.get(Object.keys(FIELDS));
  for (const [key, id] of Object.entries(FIELDS)) {
    if (stored[key] !== undefined) $(id).value = stored[key];
  }
}

$('save').addEventListener('click', async () => {
  const values = {};
  for (const [key, id] of Object.entries(FIELDS)) {
    values[key] = $(id).value.trim();
  }
  await chrome.storage.local.set(values);
  $('saved-status').textContent = 'Saved';
  setTimeout(() => { $('saved-status').textContent = ''; }, 1500);
});

$('import-run').addEventListener('click', async () => {
  const raw = $('import-source').value.trim();
  const status = $('import-status');
  if (raw.length < 80) {
    status.textContent = 'Paste more text first (at least a few CV sections).';
    return;
  }
  // Uses the key from the form even if not saved yet, falling back to storage.
  if ($('api-key').value.trim()) {
    await chrome.storage.local.set({ apiKey: $('api-key').value.trim() });
  }
  $('import-run').disabled = true;
  status.textContent = 'Structuring…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'anthropic',
      payload: { ...buildProfileImportRequest(raw), maxTokens: 2000 },
    });
    if (!res?.ok) {
      throw new Error(res?.error === 'NO_API_KEY'
        ? 'Set your Anthropic API key first.'
        : (res?.error || 'No response from background worker'));
    }
    $('profile').value = res.text.trim();
    status.textContent = 'Draft ready above. Review it, edit anything off, then click Save.';
  } catch (err) {
    status.textContent = String(err.message || err);
  } finally {
    $('import-run').disabled = false;
  }
});

load();
