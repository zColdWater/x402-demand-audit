// Renders the static page at build time (no client-side data fetching: crawlable, works with JS disabled).
// All catalog text is third-party input: every value goes through esc(); no third-party URL becomes a link.

import { isChecksummedAddress, looksLikeSolanaAddress } from './eip55.mjs';

export const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const int = (n) => (n == null ? '–' : Math.round(Number(n)).toLocaleString('en-US'));
const pct = (x, d = 1) => (x == null ? '–' : (Number(x) * 100).toFixed(d) + '%');
const usd = (x) => {
  if (x == null) return '–';
  const v = Number(x);
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + v.toFixed(v < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
};
const short = (a) => (a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '–');
const ago = (iso, nowMs) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '–';
  const h = (nowMs - t) / 36e5;
  if (h < 1) return '<1h ago';
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
};
const flagChips = (flags) => (flags || []).map((f) => `<span class="chip chip-${esc(f.toLowerCase())}" title="${esc(f)}">${esc(f.replace(/_/g, ' ').toLowerCase())}</span>`).join(' ');

function resourceCell(r) {
  const svc = r.service ? `<div class="svc">${esc(r.service)}</div>` : '';
  const desc = r.description ? `<div class="desc">${esc(r.description)}</div>` : '';
  return `<td class="res"><code>${esc(r.resource)}</code>${svc}${desc}</td>`;
}

function rowsTable(rows, nowMs, { showFlags = true } = {}) {
  if (!rows || !rows.length) return '<p class="muted">No rows in this snapshot.</p>';
  const body = rows
    .map(
      (r, i) => `<tr>
<td class="num rank">${i + 1}</td>${resourceCell(r)}
<td class="num">${int(r.payers_30d)}</td><td class="num">${int(r.calls_30d)}</td><td class="num">${r.calls_per_payer == null ? '–' : esc(r.calls_per_payer)}</td>
<td class="num">${usd(r.price_usd)}</td><td class="nets">${esc((r.networks || []).join(', '))}</td><td class="when">${esc(ago(r.last_called_at, nowMs))}</td>
${showFlags ? `<td class="flags">${flagChips(r.flags)}</td>` : ''}</tr>`
    )
    .join('\n');
  return `<div class="tbl"><table>
<thead><tr><th>#</th><th>Resource</th><th class="num">Unique payers 30d</th><th class="num">Calls 30d</th><th class="num">Calls / payer</th><th class="num">Price</th><th>Networks</th><th>Last paid</th>${showFlags ? '<th>Flags</th>' : ''}</tr></thead>
<tbody>
${body}
</tbody></table></div>`;
}

function tipBox(tip) {
  const evm = tip && isChecksummedAddress(tip.evm) ? tip.evm : null;
  const sol = tip && looksLikeSolanaAddress(tip.solana) ? tip.solana : null;
  if (!evm && !sol) return '';
  const lines = [];
  if (evm) {
    const link = `ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=${evm}&uint256=1e6`;
    lines.push(`<div class="addr"><span class="lbl">USDC on Base (or any EVM chain)</span><code id="tip-evm">${esc(evm)}</code> <button type="button" class="copy" data-copy="tip-evm">Copy</button> <a class="wallet" href="${esc(link)}">Open in wallet: 1 USDC on Base</a></div>`);
  }
  if (sol) lines.push(`<div class="addr"><span class="lbl">USDC or SOL on Solana</span><code id="tip-sol">${esc(sol)}</code> <button type="button" class="copy" data-copy="tip-sol">Copy</button></div>`);
  return `<section id="support" class="card support">
<h2>Keep this audit running</h2>
<p>The page and the data are free and stay free. If it saved you time, you can send a tip. Tips are voluntary donations: nothing is sold and there are no perks. Double-check the address in your wallet before you send.</p>
${lines.join('\n')}
</section>`;
}

function onchainTable(onchain) {
  if (!onchain || !Array.isArray(onchain.results) || !onchain.results.length) return '';
  const rows = onchain.results
    .map((r) => {
      if (r.status !== 'ok')
        return `<tr><td><code>${esc(short(r.pay_to))}</code><div class="desc">${esc(r.host)}</div></td><td>${esc(r.why)}</td><td class="num">${int(r.catalog_payers_30d)}</td><td colspan="5" class="muted">${esc(r.status)}: ${esc(r.error || '')}</td></tr>`;
      return `<tr><td><code title="${esc(r.pay_to)}">${esc(short(r.pay_to))}</code><div class="desc">${esc(r.host)}</div></td><td>${esc(r.why)}</td>
<td class="num">${int(r.catalog_payers_30d)}</td><td class="num">${int(r.onchain_eip3009_unique_payers)}</td><td class="num">${int(r.onchain_eip3009_payments)}</td>
<td class="num">${r.onchain_top_sender_share == null ? '–' : pct(r.onchain_top_sender_share, 0)}</td><td class="num">${r.onchain_round_trip_share == null ? '–' : pct(r.onchain_round_trip_share, 0)}</td>
<td class="num">${r.window_hours_covered == null ? '–' : esc(r.window_hours_covered) + 'h' + (r.window_complete ? '' : ' (partial)')}</td></tr>`;
    })
    .join('\n');
  return `<section id="onchain" class="card">
<h2>On-chain spot-check (Base, last ~${esc(onchain.hours)}h)</h2>
<p>For a few payTo addresses we read USDC transfers on Base directly from public RPC and count EIP-3009 authorizations (the settlement path x402 "exact" uses). <b>Top sender share</b> is the share of inbound USDC from the single largest sender; <b>round-trip</b> is inbound USDC matched by USDC sent back to the same wallets. These are descriptive signals from a short window, not findings about intent.</p>
<div class="tbl"><table><thead><tr><th>payTo</th><th>Why picked</th><th class="num">Catalog payers 30d</th><th class="num">On-chain payers</th><th class="num">On-chain payments</th><th class="num">Top sender share</th><th class="num">Round-trip</th><th class="num">Window</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="muted small">Checked ${esc(onchain.generated_at)}. Window coverage can be partial for very busy addresses (log caps on public RPC).</p>
</section>`;
}

export function renderPage({ summary, onchain = null, tip = null, siteUrl = null, history = [] } = {}) {
  const now = summary ? Date.parse(summary.generated_at) : Date.now();
  const title = 'x402 Demand Audit';
  const metaDesc = 'Which x402 paid APIs have real, distinct paying agents, and which have volume from a handful of wallets? A daily open-data audit of the Coinbase CDP x402 Bazaar: unique payers vs. calls, concentration flags, price vs. reach.';
  const abs = (p) => (siteUrl ? siteUrl.replace(/\/?$/, '/') + p : p);
  const ld = siteUrl
    ? `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        name: 'x402 Demand Audit: unique payers vs. call volume in the x402 Bazaar',
        description: metaDesc,
        url: abs(''),
        isAccessibleForFree: true,
        license: 'https://creativecommons.org/publicdomain/zero/1.0/',
        creator: { '@type': 'Organization', name: 'x402 Demand Audit (maintained by an AI agent, Dex)' },
        temporalCoverage: summary ? `${new Date(now - 30 * 864e5).toISOString().slice(0, 10)}/${summary.generated_at.slice(0, 10)}` : undefined,
        distribution: [
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: abs('data/summary.json') },
          { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: abs('data/resources.csv') },
        ],
      }).replace(/</g, '\\u003c')}</script>`
    : '';

  let main;
  if (!summary) {
    main = `<section class="card"><h2>First snapshot pending</h2><p>The daily job has not produced data yet. Check back after the next refresh.</p></section>`;
  } else {
    const h = summary.headline;
    const partialBanner =
      summary.coverage != null && summary.coverage < 0.98
        ? `<div class="banner">Partial snapshot: ${int(summary.resources_analyzed)} of ${int(summary.listed_total)} listed resources (${pct(summary.coverage)}) were read. Shares below describe the part that was read.</div>`
        : '';
    const tiles = [
      [int(summary.listed_total ?? summary.resources_analyzed), 'resources listed in the CDP Bazaar'],
      [pct(h.share_resources_le1_payer), 'had at most 1 unique payer in 30 days'],
      [int(h.resources_10plus_payers), `reached 10+ unique payers (${pct(h.share_resources_10plus_payers)})`],
      [pct(h.share_calls_top10_resources), 'of all paid calls went to the top 10 resources'],
      [pct(h.share_calls_concentrated_or_lockstep), 'of paid calls came from concentrated or lockstep resources'],
      [usd(h.median_price_usd_10plus_payers), 'median price among resources with 10+ payers'],
    ]
      .map(([v, l]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`)
      .join('\n');

    const dist = summary.payer_distribution
      .map((b) => `<tr><td>${esc(b.bucket)}</td><td class="num">${int(b.resources)}</td><td class="num">${pct(b.share_of_resources)}</td><td class="num">${int(b.calls_30d)}</td><td class="num">${pct(b.share_of_calls)}</td><td><span class="bar" style="width:${Math.round(b.share_of_resources * 100)}%"></span></td></tr>`)
      .join('\n');
    const price = summary.price_vs_reach
      .map((b) => `<tr><td>${esc(b.bucket)}</td><td class="num">${int(b.resources)}</td><td class="num">${int(b.with_10plus_payers)}</td><td class="num">${pct(b.share_with_10plus_payers)}</td><td class="num">${b.median_payers_30d == null ? '–' : esc(b.median_payers_30d)}</td><td class="num">${int(b.payer_endpoint_pairs)}</td></tr>`)
      .join('\n');
    const tags = (summary.tags || [])
      .slice(0, 20)
      .map((t) => `<tr><td>${esc(t.tag)}</td><td class="num">${int(t.resources)}</td><td class="num">${int(t.with_10plus_payers)}</td><td class="num">${int(t.payer_endpoint_pairs)}</td><td class="num">${int(t.calls_30d)}</td></tr>`)
      .join('\n');
    const lock = (summary.lockstep_groups || [])
      .map((g) => `<tr><td><code title="${esc(g.pay_to)}">${esc(short(g.pay_to))}</code></td><td>${esc(g.hosts.join(', '))}</td><td class="num">${int(g.endpoints)}</td><td class="num">${int(g.median_calls_30d)}</td><td class="num">${int(g.sum_calls_30d)}</td><td class="num">${int(g.max_payers_30d)}</td></tr>`)
      .join('\n');
    const flagDefs = Object.entries(summary.flag_definitions || {})
      .map(([k, v]) => `<li>${flagChips([k])} ${esc(v)}</li>`)
      .join('\n');
    const nets = (summary.networks || [])
      .slice(0, 8)
      .map((n) => `${esc(n.network)} ${pct(n.share, 0)}`)
      .join(' · ');
    const hist = (history || []).length
      ? `<p class="small muted">History: ${history.map((d) => `<a href="data/history/${esc(d)}.json">${esc(d)}</a>`).join(' · ')}</p>`
      : '';

    main = `${partialBanner}
<section class="tiles">${tiles}</section>

<section id="reach" class="card">
<h2>Where the paying agents are: top resources by unique payers</h2>
<p>Ranked by distinct wallets that paid in the last 30 days, the closest public proxy for real demand. Volume rankings reward repeat calls; this one rewards reach.</p>
${rowsTable(summary.top_by_payers.slice(0, 40), now)}
</section>

<section id="volume" class="card">
<h2>Volume is not demand: top resources by paid calls</h2>
<p>Same catalog, ranked by 30-day call count. Compare the <b>calls / payer</b> column with the table above.</p>
${rowsTable(summary.top_by_calls.slice(0, 30), now)}
</section>

${lock ? `<section id="lockstep" class="card"><h2>Lockstep groups</h2><p>Sellers with 4 or more endpoints whose 30-day call counts are within 3% of each other. This is a pattern, not proof: a client that calls a fixed list of endpoints in rotation produces it as well.</p>
<div class="tbl"><table><thead><tr><th>payTo</th><th>Hosts</th><th class="num">Endpoints</th><th class="num">Median calls 30d</th><th class="num">Sum calls 30d</th><th class="num">Max payers 30d</th></tr></thead><tbody>
${lock}
</tbody></table></div></section>` : ''}

<section id="distribution" class="card">
<h2>How thin is demand?</h2>
<div class="tbl"><table><thead><tr><th>Unique payers (30d)</th><th class="num">Resources</th><th class="num">Share</th><th class="num">Calls 30d</th><th class="num">Share of calls</th><th></th></tr></thead><tbody>
${dist}
</tbody></table></div>
<p class="small muted">Networks accepted (share of mainnet resources): ${nets}</p>
</section>

<section id="price" class="card">
<h2>Price vs. reach</h2>
<p>Which price points actually attract distinct payers? Price is the cheapest mainnet USDC option (Base preferred); resources priced in other assets are left out.</p>
<div class="tbl"><table><thead><tr><th>Price per call</th><th class="num">Resources</th><th class="num">With 10+ payers</th><th class="num">Share</th><th class="num">Median payers</th><th class="num">Payer-endpoint pairs</th></tr></thead><tbody>
${price}
</tbody></table></div>
</section>

${tags ? `<section id="tags" class="card"><h2>Demand by tag</h2><p>Tags as declared by sellers. Payer-endpoint pairs add up unique payers per resource, so one wallet that pays three endpoints counts three times.</p>
<div class="tbl"><table><thead><tr><th>Tag</th><th class="num">Resources</th><th class="num">With 10+ payers</th><th class="num">Payer-endpoint pairs</th><th class="num">Calls 30d</th></tr></thead><tbody>
${tags}
</tbody></table></div></section>` : ''}

${onchainTable(onchain)}

<section id="method" class="card">
<h2>Method and caveats</h2>
<ul>
<li><b>Source.</b> The public, keyless CDP discovery endpoint <code>api.cdp.coinbase.com/platform/v2/x402/discovery/resources</code>, read page by page once a day. "Calls 30d", "unique payers 30d" and "last paid" are CDP's own rolling metrics. We do not alter them.</li>
<li><b>Scope.</b> Only resources indexed in the CDP Bazaar. Per CDP's docs, indexing needs a paid call settled through the CDP facilitator, so services that settle elsewhere (other facilitators, direct transfers) do not appear here.</li>
<li><b>Flags are descriptive.</b> They mark statistical patterns, not intent. Legitimate services can trigger them (one B2B customer calling a lot, a batch of first-time trials, a client rotating through a fixed endpoint list).</li>
<li><b>Payer counts across resources overlap.</b> One wallet that pays several endpoints is counted once per endpoint.</li>
<li><b>Snapshot timing.</b> The catalog changes while it is being read; duplicates are removed by resource URL.</li>
</ul>
<h3>Flags</h3>
<ul class="flags-def">${flagDefs}</ul>
</section>

<section id="data" class="card">
<h2>Data</h2>
<p>Free to reuse (CC0 for our derived data; the underlying listings belong to their publishers). Agents can read these directly, no key needed:</p>
<ul>
<li><a href="data/summary.json">data/summary.json</a> — everything on this page, machine-readable</li>
<li><a href="data/resources.csv">data/resources.csv</a> — one row per listed resource with metrics and flags</li>
${onchain ? '<li><a href="data/onchain.json">data/onchain.json</a> — on-chain spot-check results</li>' : ''}
<li><a href="data/meta.json">data/meta.json</a> — snapshot time, coverage, fetch errors</li>
</ul>
${hist}
</section>`;
  }

  const gen = summary ? `Snapshot ${esc(summary.generated_at.replace('T', ' ').slice(0, 16))} UTC · ${int(summary.resources_analyzed)} resources read` : 'No snapshot yet';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}">
${siteUrl ? `<link rel="canonical" href="${esc(abs(''))}">` : ''}
${ld}
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#16181d;--muted:#5d6370;--line:#e3e4e8;--accent:#1f5fd6;--warn:#b45309;--warn-bg:#fff4e5;--chip:#eef1f6;--bar:#1f5fd6}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1115;--card:#171a21;--ink:#e8eaee;--muted:#9aa1ad;--line:#2a2f3a;--accent:#7aa7ff;--warn:#f0b35a;--warn-bg:#2b2112;--chip:#232834;--bar:#7aa7ff}}
:root[data-theme="dark"]{--bg:#0f1115;--card:#171a21;--ink:#e8eaee;--muted:#9aa1ad;--line:#2a2f3a;--accent:#7aa7ff;--warn:#f0b35a;--warn-bg:#2b2112;--chip:#232834;--bar:#7aa7ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}
header p{margin:4px 0;color:var(--muted)}
.gen{font-size:13px;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.tile .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.tile .l{font-size:13px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
.card h2{font-size:18px;margin:0 0 6px}
.card h3{font-size:15px;margin:14px 0 6px}
.card p{margin:6px 0 12px;color:var(--muted)}
.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.rank{color:var(--muted)}
td.res{min-width:260px;max-width:420px}
td.res code{word-break:break-all;font-size:12px}
.svc{font-weight:600;font-size:12px;margin-top:2px}
.desc{color:var(--muted);font-size:12px}
.nets,.when{white-space:nowrap;color:var(--muted)}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:11px;margin:1px 0;white-space:nowrap}
.chip-high_concentration,.chip-lockstep_calls{background:var(--warn-bg);color:var(--warn)}
.bar{display:inline-block;height:8px;background:var(--bar);border-radius:4px;min-width:2px}
.banner{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 14px;margin:12px 0}
.muted{color:var(--muted)}.small{font-size:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--accent)}
.support .addr{margin:8px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.support .lbl{font-size:12px;color:var(--muted);width:100%}
.support code{background:var(--chip);padding:4px 8px;border-radius:6px;word-break:break-all}
button.copy{font:inherit;font-size:12px;padding:3px 10px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;cursor:pointer}
.flags-def{list-style:none;padding:0}.flags-def li{margin:6px 0;color:var(--muted)}
footer{color:var(--muted);font-size:12px;margin-top:28px}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>x402 Demand Audit</h1>
<p>Which paid APIs in the x402 Bazaar have many distinct paying agents, and which get their volume from a handful of wallets? Refreshed daily from public data.</p>
<div class="gen">${gen}</div>
</header>
${main}
${tipBox(tip)}
<footer>
<p>Built and maintained by Dex, an AI agent, as part of an experiment in agent-run projects. Tips reach the agent's wallet, which the experiment's operator holds. Not affiliated with Coinbase or any listed service. Not financial advice. Code: MIT. Derived data: CC0.</p>
</footer>
</div>
<script>
document.querySelectorAll('button.copy').forEach(function(b){b.addEventListener('click',function(){var el=document.getElementById(b.getAttribute('data-copy'));if(!el)return;var t=el.textContent;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)}).catch(function(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)})})});
</script>
</body>
</html>
`;
}
