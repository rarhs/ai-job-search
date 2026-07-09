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

load();
