// Runs on every http(s) page at document_idle. Purely local: parses JSON-LD,
// never reads user data, never talks to the network. If the page declares a
// schema.org JobPosting, tells the background worker to light up the badge.

function hasJobPosting() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
      if (nodes.some((n) => n && String(n['@type']).includes('JobPosting'))) return true;
    } catch { /* malformed JSON-LD */ }
  }
  return false;
}

if (hasJobPosting()) {
  chrome.runtime.sendMessage({ type: 'job-detected' });
}
