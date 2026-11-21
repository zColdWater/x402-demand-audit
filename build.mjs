#!/usr/bin/env node
// x402 Demand Audit — daily build. Zero dependencies, Node >= 18 (global fetch).
//
//   node build.mjs                          # fetch the CDP Bazaar catalog, analyze, write data/ + index.html
//   node build.mjs --onchain 12             # also spot-check 12 Base payTo addresses on-chain (public RPC)
//   node build.mjs --site-url https://<user>.github.io/x402-demand-audit/
//   node build.mjs --fixture test/fixture.json   # offline: build from a saved catalog response
//   node build.mjs --render-only            # re-render index.html from data/summary.json (no network)
//
// Network access: GET api.cdp.coinbase.com (public, keyless) and, with --onchain, read-only JSON-RPC to public
// Base endpoints. Nothing is posted anywhere. Output goes only to ./data and ./index.html.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCatalog, CDP_DISCOVERY } from './lib/fetch.mjs';
import { toRow, analyze, toCsv } from './lib/analyze.mjs';
import { renderPage } from './lib/render.mjs';
import { isChecksummedAddress, looksLikeSolanaAddress } from './lib/eip55.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const HIST = path.join(DATA, 'history');

function args(argv) {
  const o = { onchain: 0, siteUrl: null, fixture: null, renderOnly: false, maxPages: 600, delayMs: 250, limit: 100, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--onchain') o.onchain = Math.max(0, Math.min(30, Number(argv[++i]) || 0));
    else if (a === '--site-url') o.siteUrl = String(argv[++i] || '') || null;
    else if (a === '--fixture') o.fixture = argv[++i];
    else if (a === '--render-only') o.renderOnly = true;
    else if (a === '--max-pages') o.maxPages = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--delay-ms') o.delayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--limit') o.limit = Math.max(1, Math.min(1000, Number(argv[++i]) || 100));
    else if (a === '--quiet') o.quiet = true;
    else throw new Error('unknown argument: ' + a);
  }
  if (o.siteUrl && !/^https:\/\/[^\s"'<>]+$/.test(o.siteUrl)) throw new Error('--site-url must be an https URL');
  return o;
}

export function loadTip(root = ROOT) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const tip = cfg.tip || {};
  if (tip.evm && !isChecksummedAddress(tip.evm)) throw new Error('config.json tip.evm is not a valid EIP-55 checksummed address; refusing to build');
  if (tip.solana && !looksLikeSolanaAddress(tip.solana)) throw new Error('config.json tip.solana is not a valid base58 address; refusing to build');
  return tip;
}

const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n');

// sitemap.xml + robots.txt for search engines (only when the public URL is known).
export function writeSiteFiles(root, siteUrl, lastmodIso) {
  if (!siteUrl) return false;
  const base = siteUrl.replace(/\/?$/, '/');
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lastmod = (lastmodIso || new Date().toISOString()).slice(0, 10);
  const urls = [base, base + 'data/summary.json', base + 'data/resources.csv'];
  fs.writeFileSync(
    path.join(root, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xmlEsc(u)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq></url>`).join('\n')}\n</urlset>\n`
  );
  fs.writeFileSync(path.join(root, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}sitemap.xml\n`);
  return true;
}
const historyDays = () => (fs.existsSync(HIST) ? fs.readdirSync(HIST).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse().slice(0, 60) : []);

async function main() {
  const o = args(process.argv.slice(2));
  const log = o.quiet ? () => {} : (m) => console.log(m);
  const tip = loadTip();
  fs.mkdirSync(HIST, { recursive: true });

  if (o.renderOnly) {
    const sp = path.join(DATA, 'summary.json');
    const summary = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
    const op = path.join(DATA, 'onchain.json');
    const onchain = fs.existsSync(op) ? JSON.parse(fs.readFileSync(op, 'utf8')) : null;
    fs.writeFileSync(path.join(ROOT, 'index.html'), renderPage({ summary, onchain, tip, siteUrl: o.siteUrl, history: historyDays() }));
    writeSiteFiles(ROOT, o.siteUrl, summary && summary.generated_at);
    log('rendered index.html' + (summary ? '' : ' (no data yet: placeholder)'));
    return;
  }

  const rows = [];
  let fetchInfo;
  if (o.fixture) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(o.fixture), 'utf8'));
    const items = Array.isArray(raw.items) ? raw.items : [];
    for (const it of items) rows.push(toRow(it));
    fetchInfo = { total: raw.pagination && Number(raw.pagination.total) ? Number(raw.pagination.total) : items.length, fetched: items.length, pages: 1, partial: false, errors: [], source: 'fixture:' + path.basename(o.fixture) };
  } else {
    fetchInfo = await fetchCatalog({ limit: o.limit, maxPages: o.maxPages, delayMs: o.delayMs, log, onPage: (items) => { for (const it of items) rows.push(toRow(it)); } });
  }
  if (!rows.length) {
    // Do not overwrite a good snapshot with an empty one.
    console.error('no rows fetched; keeping the previous snapshot. errors: ' + JSON.stringify(fetchInfo.errors));
    process.exit(2);
  }

  const nowMs = Date.now();
  const { rows: clean, summary } = analyze(rows, { nowMs, listedTotal: fetchInfo.total });
  summary.source = fetchInfo.source === CDP_DISCOVERY ? 'CDP x402 Bazaar discovery API (public)' : fetchInfo.source;
  summary.fetch = { pages: fetchInfo.pages, fetched: fetchInfo.fetched, partial: fetchInfo.partial, errors: fetchInfo.errors.slice(0, 5) };

  let onchain = null;
  if (o.onchain > 0) {
    const { pickTargets, spotCheck } = await import('./lib/onchain.mjs');
    const targets = pickTargets(summary, clean, o.onchain);
    log(`on-chain spot-check of ${targets.length} payTo addresses`);
    onchain = await spotCheck(targets, { log });
    writeJson(path.join(DATA, 'onchain.json'), onchain);
  } else if (fs.existsSync(path.join(DATA, 'onchain.json'))) {
    onchain = JSON.parse(fs.readFileSync(path.join(DATA, 'onchain.json'), 'utf8'));
  }

  writeJson(path.join(DATA, 'summary.json'), summary);
  fs.writeFileSync(path.join(DATA, 'resources.csv'), toCsv(clean));
  const day = summary.generated_at.slice(0, 10);
  const { top_by_calls, most_concentrated, ...lean } = summary;
  writeJson(path.join(HIST, day + '.json'), { ...lean, top_by_payers: summary.top_by_payers.slice(0, 50) });
  writeJson(path.join(DATA, 'meta.json'), {
    generated_at: summary.generated_at,
    source: summary.source,
    listed_total: summary.listed_total,
    resources_analyzed: summary.resources_analyzed,
    coverage: summary.coverage,
    fetch: summary.fetch,
    onchain_checked: onchain ? onchain.results.length : 0,
  });
  fs.writeFileSync(path.join(ROOT, 'index.html'), renderPage({ summary, onchain, tip, siteUrl: o.siteUrl, history: historyDays() }));
  writeSiteFiles(ROOT, o.siteUrl, summary.generated_at);
  log(`done: ${summary.resources_analyzed} resources (listed ${summary.listed_total}), coverage ${summary.coverage}, partial=${fetchInfo.partial}`);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('build failed: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
