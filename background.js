// Lomb Input: background service worker.
// Fetches dictionary entries from English Wiktionary for the hover dictionary and the expression (idiom) list.
// Only builds Wiktionary URLs itself (never fetches an arbitrary URL from a page).

const UA = 'LombInput/0.5 (personal language-learning browser extension)';

const URLS = {
  // Structured definitions, keyed by language code ("experimental" Wikimedia endpoint).
  def: t => `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(t)}`,
  // Full page HTML (MediaWiki core REST API): fallback if the endpoint above stops working.
  html: t => `https://en.wiktionary.org/w/rest.php/v1/page/${encodeURIComponent(t)}/html`,
  // Category members, e.g. "German idioms|<continue token>" (expression list).
  cat: t => {
    const [cat, cont] = t.split('|');
    return `https://en.wiktionary.org/w/api.php?action=query&list=categorymembers&cmnamespace=0&cmlimit=500&format=json` +
      `&cmtitle=${encodeURIComponent('Category:' + cat)}${cont ? '&cmcontinue=' + encodeURIComponent(cont) : ''}`;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'bundled' && /^[a-z]{2,3}$/.test(msg.lang || '')) {   // expression list shipped in lists/
    fetch(chrome.runtime.getURL(`lists/${msg.lang}.json`))
      .then(async r => sendResponse({ status: r.status, body: r.ok ? await r.text() : '' }))
      .catch(() => sendResponse({ status: 0, body: '' }));
    return true;
  }
  if (!msg || msg.type !== 'wikt' || !URLS[msg.kind] || typeof msg.term !== 'string' || msg.term.length > 300) return;
  fetch(URLS[msg.kind](msg.term), { headers: { 'Api-User-Agent': UA } })
    .then(async r => sendResponse({ status: r.status, body: r.ok ? await r.text() : '' }))
    .catch(() => sendResponse({ status: 0, body: '' }));
  return true; // async response
});
