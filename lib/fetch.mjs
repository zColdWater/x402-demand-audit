// Paginated, polite reader for the public CDP x402 Bazaar discovery catalog.
//   GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=100&offset=N
// Response shape (checked 2026-11-21): { items: [...], pagination: { limit, offset, total }, x402Version: 2 }.
// Each item: resource, type, x402Version, accepts[], lastUpdated, quality{l30DaysTotalCalls,l30DaysUniquePayers,lastCalledAt},
// plus optional description, serviceName, tags, curated, extensions, iconUrl.
//
// No API key. Retries 429/5xx/network errors with backoff (honours Retry-After). If a page keeps failing we stop
// and return what we have, flagged partial: a partial snapshot is published as partial, never as complete.

export const CDP_DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchCatalog({
  base = CDP_DISCOVERY,
  limit = 100,
  maxPages = 600,
  delayMs = 250,
  retries = 5,
  timeoutMs = 30000,
  fetchImpl = (...a) => globalThis.fetch(...a),
  sleep = sleepReal,
  onPage = null, // (rawItems, info) => void — lets the caller compact items as they stream in
  log = () => {},
} = {}) {
  let offset = 0;
  let total = null;
  let pages = 0;
  let fetched = 0;
  const errors = [];
  let partial = false;

  while (pages < maxPages) {
    const url = `${base}?type=http&limit=${limit}&offset=${offset}`;
    let body = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
        let res;
        try {
          res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'x402-demand-audit (open data; +github pages)' }, signal: ctl ? ctl.signal : undefined });
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          lastErr = `HTTP ${res.status}`;
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : Math.min(2 ** attempt * 1000, 60000));
          continue;
        }
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          break; // 4xx other than 429: retrying will not help
        }
        const text = await res.text();
        body = JSON.parse(text);
        if (!body || typeof body !== 'object') throw new Error('non-object JSON');
        break;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        body = null;
        await sleep(Math.min(2 ** attempt * 1000, 60000));
      }
    }
    if (!body) {
      errors.push({ offset, error: lastErr });
      partial = true;
      log(`page at offset ${offset} failed: ${lastErr}; stopping with a partial snapshot`);
      break;
    }
    const items = Array.isArray(body.items) ? body.items : Array.isArray(body.resources) ? body.resources : [];
    const pg = body.pagination || {};
    if (Number.isFinite(Number(pg.total))) total = Number(pg.total);
    pages++;
    fetched += items.length;
    if (onPage) onPage(items, { offset, pages, total });
    log(`page ${pages}: offset ${offset}, +${items.length} (have ${fetched}${total !== null ? ' of ' + total : ''})`);
    if (items.length === 0) break;
    offset += items.length; // advance by what we actually got (server may cap limit below what we asked)
    if (total !== null && offset >= total) break;
    if (delayMs) await sleep(delayMs);
  }
  if (pages >= maxPages && total !== null && offset < total) partial = true;
  return { total, fetched, pages, partial, errors, source: base };
}
