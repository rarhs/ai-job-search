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

// Content script detected a schema.org JobPosting on this tab.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'job-detected' || sender.tab?.id === undefined) return false;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'JOB' });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2e7d32' });
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'anthropic') return false;
  callAnthropic(message.payload)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // async sendResponse
});

// Streaming variant over a long-lived port: emits {type:'delta', text} chunks,
// then {type:'done', text, usage, model} with token counts from the SSE stream.
async function streamAnthropic({ system, user, maxTokens }, onDelta) {
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
      stream: true,
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json())?.error?.message || detail;
    } catch { /* keep status text */ }
    throw new Error(`API_ERROR: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const usage = { input: 0, output: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const raw of events) {
      const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      let event;
      try { event = JSON.parse(dataLine.slice(5)); } catch { continue; }
      if (event.type === 'message_start') {
        usage.input = event.message?.usage?.input_tokens ?? 0;
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        onDelta(event.delta.text);
      } else if (event.type === 'message_delta' && event.usage?.output_tokens != null) {
        usage.output = event.usage.output_tokens;
      }
    }
  }

  if (!text) throw new Error('API_ERROR: empty response');
  return { text, usage, model };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'anthropic-stream') return;
  port.onMessage.addListener((payload) => {
    streamAnthropic(payload, (chunk) => port.postMessage({ type: 'delta', text: chunk }))
      .then((result) => port.postMessage({ type: 'done', ...result }))
      .catch((err) => port.postMessage({ type: 'error', error: String(err.message || err) }));
  });
});
