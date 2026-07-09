// Service worker: sole owner of Anthropic API calls so the key never enters
// page or popup DOM context beyond storage reads.

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-5';

async function getSettings() {
  const stored = await chrome.storage.local.get(['apiKey', 'model', 'baseUrl', 'profile']);
  return {
    apiKey: stored.apiKey || '',
    model: stored.model || DEFAULT_MODEL,
    baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    profile: stored.profile || '',
  };
}

async function callAnthropic({ system, user, maxTokens }) {
  const { apiKey, model, baseUrl } = await getSettings();
  if (!apiKey) throw new Error('NO_API_KEY');

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 2048,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err?.error?.message || detail;
    } catch { /* keep status text */ }
    throw new Error(`API_ERROR: ${detail}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error('API_ERROR: empty response');
  return text;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'anthropic') return false;
  callAnthropic(message.payload)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // async sendResponse
});
