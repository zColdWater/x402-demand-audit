// Offline tests for x402 Demand Audit. No network, no dependencies:  node test/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, toChecksumAddress, isChecksummedAddress, looksLikeSolanaAddress } from '../lib/eip55.mjs';
import { toRow, analyze, toCsv, priceOf, normNetwork, applyFlags } from '../lib/analyze.mjs';
import { fetchCatalog } from '../lib/fetch.mjs';
import { renderPage, esc } from '../lib/render.mjs';
import { pickTargets, spotCheck } from '../lib/onchain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
let passed = 0;
let failed = 0;
const ok = (c, name, extra) => {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
  }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ---------------------------------------------------------------- EIP-55
console.log('# eip55');
eq(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("") vector');
eq(toChecksumAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC on Base checksum');
// EIP-55 spec test vectors
for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'])
  ok(isChecksummedAddress(a), 'EIP-55 spec vector ' + a);
ok(!isChecksummedAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), 'all-lowercase rejected (no checksum)');
ok(!isChecksummedAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), 'one flipped case rejected');
ok(!isChecksummedAddress('0x1234'), 'short rejected');
ok(looksLikeSolanaAddress('2W5wzUwpGmkDSketk5fxcnPevv8UYcHEZfMUxfJoimge'), 'solana address shape');
ok(!looksLikeSolanaAddress('0OIl-not-base58'), 'non-base58 rejected');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
ok(isChecksummedAddress(cfg.tip.evm), 'config tip.evm passes EIP-55', cfg.tip.evm);
ok(looksLikeSolanaAddress(cfg.tip.solana), 'config tip.solana is base58');
// When run inside the arena (founders/f05/workspace/x402-demand-audit), the tip addresses must be f05's own.
const wallets = path.join(ROOT, '..', '..', 'wallets.json');
if (fs.existsSync(wallets)) {
  const w = JSON.parse(fs.readFileSync(wallets, 'utf8'));
  eq(cfg.tip.evm, w.evm, 'tip.evm equals founders/f05/wallets.json evm');
  eq(cfg.tip.solana, w.solana, 'tip.solana equals founders/f05/wallets.json solana');
} else console.log('  (wallets.json not present: skipped arena address cross-check)');

// ---------------------------------------------------------------- normalization
console.log('# normalize');
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture.json'), 'utf8'));
eq(normNetwork('eip155:8453'), 'base', 'eip155:8453 -> base');
eq(normNetwork('base'), 'base', 'v1 base -> base');
eq(normNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana', 'solana mainnet');
eq(normNetwork('eip155:999999'), 'eip155:999999', 'unknown network kept raw');
const rows = fx.items.map(toRow);
const byRes = (s) => rows.find((r) => r.resource.includes(s));
eq(byRes('send-native').price_usd, 0.05, 'v2 amount -> $0.05');
eq(byRes('v1-j').price_usd, 0.01, 'v1 maxAmountRequired -> $0.01');
eq(byRes('v1-j').calls_30d, 0, 'missing quality -> 0 calls');
eq(byRes('v1-j').description, 'v1 description', 'v1 description from accepts');
eq(byRes('odd-l').price_usd, null, 'non-USDC asset -> price unknown');
eq(byRes('testnet-k').testnet_only, true, 'base-sepolia only -> testnet_only');
eq(byRes('search-e').networks, ['base', 'solana'], 'multi-network listing');
eq(byRes('search-e').pay_to_network, 'base', 'Base payTo preferred');
eq(byRes('grade-b').calls_per_payer, 142.51, 'calls per payer rounded to 2 dp');
eq(priceOf([{ scheme: 'upto', network: 'eip155:8453', amount: '110592', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, { scheme: 'exact', network: 'eip155:8453', amount: '2000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }]).price_usd, 0.002, 'exact preferred over upto');
eq(priceOf([]).price_usd, null, 'no accepts -> null');
eq(toRow({}).resource, '', 'empty item does not throw');
ok(toRow({ resource: 'https://x.example/' + 'a'.repeat(500) }).resource.length <= 300, 'long resource clipped');

// ---------------------------------------------------------------- flags + aggregates
console.log('# analyze');
const NOW = Date.parse('2026-11-21T00:00:00Z');
const { rows: clean, summary } = analyze(rows, { nowMs: NOW, listedTotal: fx.pagination.total });
eq(clean.length, fx.items.length - 1, 'duplicate resource removed');
eq(clean.find((r) => r.resource.includes('weather-c')).calls_30d, 1130, 'newer duplicate wins');
const fl = (s) => clean.find((r) => r.resource.includes(s)).flags;
ok(fl('/x402/ping').includes('LOCKSTEP_CALLS'), 'lockstep group detected (9 endpoints within 3%)');
ok(fl('/x402/ping').includes('HIGH_CONCENTRATION'), '44k calls / 141 payers -> HIGH_CONCENTRATION');
ok(!fl('/x402/rewrite').includes('LOCKSTEP_CALLS'), 'low-volume sibling not lockstep');
ok(fl('grade-b').includes('HIGH_CONCENTRATION'), '88k/621 -> HIGH_CONCENTRATION');
ok(!fl('send-native').includes('HIGH_CONCENTRATION'), '13k/4.5k -> not concentrated');
ok(fl('erc20-balance').includes('ONE_SHOT_PAYERS'), '743 calls / 730 payers -> ONE_SHOT_PAYERS');
ok(fl('contract/:address').includes('STALE_7D'), 'last paid 2026-11-13 -> STALE_7D');
ok(fl('lonely-i').includes('SINGLE_PAYER'), '1 payer -> SINGLE_PAYER');
eq(summary.lockstep_groups.length, 1, 'one lockstep group');
eq(summary.lockstep_groups[0].endpoints, 9, 'lockstep group size');
eq(summary.top_by_payers[0].resource, 'https://exec-a.example/api/send-token', 'top by payers');
eq(summary.top_by_calls[0].resource, 'https://grade-b.example/api/verdict', 'top by calls');
const distSum = summary.payer_distribution.reduce((s, b) => s + b.resources, 0);
eq(distSum, summary.mainnet_resources, 'payer buckets cover every mainnet resource');
ok(Math.abs(summary.payer_distribution.reduce((s, b) => s + b.share_of_calls, 0) - 1) < 0.001, 'call shares sum to 1');
eq(summary.testnet_only_resources, 1, 'testnet excluded from mainnet stats');
ok(summary.headline.share_calls_concentrated_or_lockstep > 0.5, 'most fixture volume is concentrated', summary.headline.share_calls_concentrated_or_lockstep);
eq(summary.coverage, 1, 'coverage 100% for full fixture');
ok(summary.price_vs_reach.reduce((s, b) => s + b.resources, 0) === clean.filter((r) => !r.testnet_only && r.price_usd !== null).length, 'price buckets cover all priced mainnet rows');
ok(summary.tags.some((t) => t.tag === 'blockchain'), 'tag aggregation');
// lockstep needs >= 4 endpoints
const three = [1, 2, 3].map((i) => ({ ...toRow({ resource: 'https://t.example/' + i, accepts: [{ network: 'base', payTo: '0x' + '7'.repeat(40) }], quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 10 } }) }));
eq(applyFlags(three, NOW).lockstep.length, 0, '3 endpoints are not a lockstep group');

// ---------------------------------------------------------------- CSV
console.log('# csv');
const csv = toCsv(clean);
const lines = csv.trim().split('\n');
eq(lines.length, clean.length + 1, 'csv has header + one line per row');
ok(lines[0].startsWith('resource,host,service'), 'csv header');
const evil = toCsv([{ ...clean[0], resource: '=HYPERLINK("http://e.example","x")', service: '+1', host: 'a,b', payers_30d: 1, calls_30d: 1 }]).trim().split('\n')[1];
ok(evil.startsWith(`"'=HYPERLINK(""http://e.example"",""x"")"`), 'leading = neutralized and quotes doubled', evil);
ok(evil.includes(`"a,b"`), 'comma cell quoted');
ok(evil.includes(`,'+1,`), 'leading + neutralized');
ok(lines.every((l) => !l.startsWith('=')), 'no line starts with a formula');

// ---------------------------------------------------------------- render
console.log('# render');
const html = renderPage({ summary, tip: cfg.tip, siteUrl: 'https://example.github.io/x402-demand-audit/' });
ok(!html.includes('<script>alert'), 'no raw <script> from catalog data');
ok(!html.includes('<img src=x'), 'no raw <img> from catalog data');
ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'hostile resource rendered escaped');
ok(!/href="https?:\/\/(?!example\.github\.io)[^"]*"/.test(html.replace(/<link rel="canonical"[^>]*>/, '')), 'no third-party links rendered');
ok(html.includes(cfg.tip.evm), 'tip EVM address shown');
ok(html.includes(cfg.tip.solana), 'tip Solana address shown');
ok(html.includes('voluntary'), 'tip labeled voluntary');
ok(html.includes('AI agent'), 'AI authorship disclosed');
ok(html.includes('"@type":"Dataset"'), 'schema.org Dataset JSON-LD present');
ok(!/<script type="application\/ld\+json">[^]*<\/script>[^]*<\/script>[^]*application\/ld/.test(html), 'single JSON-LD block');
const ldBlock = html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1];
ok(!ldBlock.includes('<'), 'JSON-LD has no raw "<"');
ok(JSON.parse(ldBlock).distribution.length === 2, 'JSON-LD parses');
ok(html.includes('id="reach"') && html.includes('id="volume"') && html.includes('id="lockstep"'), 'main sections present');
const badTip = renderPage({ summary, tip: { evm: '0xaa0065a4405a204513dc34619583b8d5f47290ab', solana: 'bad!' } });
ok(!badTip.includes('id="support"'), 'tip box hidden when addresses fail validation');
const empty = renderPage({ summary: null, tip: cfg.tip });
ok(empty.includes('First snapshot pending'), 'placeholder page without data');
eq(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;', 'esc covers all five characters');
const partial = renderPage({ summary: { ...summary, coverage: 0.4 }, tip: null });
ok(partial.includes('Partial snapshot'), 'partial banner when coverage < 98%');

// ---------------------------------------------------------------- fetchCatalog (mock HTTP)
console.log('# fetch');
const mkItems = (n, off) => Array.from({ length: n }, (_, i) => ({ resource: `https://m.example/${off + i}`, accepts: [], quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 } }));
const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const noSleep = async () => {};
{
  const calls = [];
  const got = [];
  const r = await fetchCatalog({
    limit: 100, delayMs: 0, sleep: noSleep,
    fetchImpl: async (url) => {
      calls.push(url);
      const off = Number(new URL(url).searchParams.get('offset'));
      const n = Math.min(40, 95 - off); // server caps page size at 40, total 95
      return resp(200, { items: mkItems(Math.max(0, n), off), pagination: { limit: 40, offset: off, total: 95 } });
    },
    onPage: (items) => got.push(...items),
  });
  eq([r.total, r.fetched, r.pages, r.partial], [95, 95, 3, false], 'pagination follows server page size');
  eq(calls.map((u) => new URL(u).searchParams.get('offset')), ['0', '40', '80'], 'offsets advance by items received');
  ok(calls.every((u) => new URL(u).searchParams.get('type') === 'http'), 'type=http filter');
  eq(got.length, 95, 'onPage receives every item');
}
{
  let n = 0;
  const sleeps = [];
  const r = await fetchCatalog({
    delayMs: 0, sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async (url) => {
      n++;
      if (n === 1) return resp(429, 'slow down', { 'retry-after': '3' });
      if (n === 2) return resp(503, 'oops');
      return resp(200, { items: mkItems(5, 0), pagination: { total: 5 } });
    },
  });
  eq([r.fetched, r.partial], [5, false], '429 then 503 then success');
  eq(sleeps.slice(0, 2), [3000, 2000], 'Retry-After honoured, then exponential backoff');
}
{
  let n = 0;
  const r = await fetchCatalog({
    delayMs: 0, sleep: noSleep, retries: 2,
    fetchImpl: async (url) => {
      n++;
      const off = Number(new URL(url).searchParams.get('offset'));
      if (off === 0) return resp(200, { items: mkItems(100, 0), pagination: { total: 300 } });
      throw new Error('ECONNRESET');
    },
  });
  eq([r.fetched, r.partial, r.errors.length], [100, true, 1], 'persistent failure -> partial snapshot, not a crash');
  eq(n, 1 + 3, 'retries bounded (1 ok + 3 attempts)');
}
{
  const r = await fetchCatalog({ delayMs: 0, sleep: noSleep, retries: 1, fetchImpl: async () => resp(200, '<html>not json') });
  eq([r.fetched, r.partial], [0, true], 'non-JSON body -> partial with 0 rows');
}
{
  let n = 0;
  const r = await fetchCatalog({ delayMs: 0, sleep: noSleep, fetchImpl: async () => (n++, resp(403, 'forbidden')) });
  eq([n, r.partial], [1, true], '403 is not retried');
}
{
  const r = await fetchCatalog({ delayMs: 0, sleep: noSleep, maxPages: 2, fetchImpl: async (url) => resp(200, { items: mkItems(10, Number(new URL(url).searchParams.get('offset'))), pagination: { total: 1000 } }) });
  eq([r.pages, r.partial], [2, true], 'maxPages cap marks snapshot partial');
}

// ---------------------------------------------------------------- on-chain spot-check (mock RPC)
console.log('# onchain');
const targets = pickTargets(summary, clean, 4);
eq(targets.length, 4, 'picks requested number of targets');
ok(targets.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.pay_to)), 'only EVM payTo addresses');
eq(new Set(targets.map((t) => t.pay_to.toLowerCase())).size, 4, 'payTo addresses deduplicated');
eq(targets[0].why, 'high volume, concentrated', 'concentrated sellers first');
ok(targets.some((t) => t.why === 'most unique payers'), 'then widest reach');
const dead = await spotCheck(targets.slice(0, 2), { urls: ['https://rpc.mock'], fetchImpl: async () => { throw new Error('rpc down'); } });
eq(dead.results.map((r) => r.status), ['error', 'error'], 'RPC failure recorded per address, no throw');
const skipped = await spotCheck(targets.slice(0, 2), { totalBudgetMs: -1, urls: ['https://rpc.mock'], fetchImpl: async () => { throw new Error('x'); } });
eq(skipped.results.map((r) => r.status), ['skipped', 'skipped'], 'time budget respected');
const ochtml = renderPage({ summary, onchain: dead, tip: null });
ok(ochtml.includes('On-chain spot-check') && ochtml.includes('error'), 'on-chain section renders errors');

// vendored module must be byte-identical to the Wallet X-Ray source when both exist
const src = path.join(ROOT, '..', 'wallet-xray', 'worker.js');
if (fs.existsSync(src)) eq(fs.readFileSync(path.join(ROOT, 'lib', 'wallet-xray.js'), 'utf8') === fs.readFileSync(src, 'utf8'), true, 'lib/wallet-xray.js identical to wallet-xray/worker.js');

// ---------------------------------------------------------------- end-to-end build from fixture (temp copy)
console.log('# build e2e');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x402da-'));
try {
  for (const f of ['build.mjs', 'config.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.mkdirSync(path.join(tmp, 'lib'));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(tmp, 'lib', f));
  execFileSync(process.execPath, [path.join(tmp, 'build.mjs'), '--fixture', path.join(HERE, 'fixture.json'), '--quiet', '--site-url', 'https://example.github.io/x402-demand-audit/'], { cwd: tmp, stdio: 'pipe' });
  for (const f of ['index.html', 'data/summary.json', 'data/resources.csv', 'data/meta.json', 'sitemap.xml', 'robots.txt']) ok(fs.existsSync(path.join(tmp, f)), 'build wrote ' + f);
  const sm = fs.readFileSync(path.join(tmp, 'sitemap.xml'), 'utf8');
  ok(sm.includes('<loc>https://example.github.io/x402-demand-audit/</loc>') && sm.includes('<changefreq>daily</changefreq>'), 'sitemap lists the page');
  ok(fs.readFileSync(path.join(tmp, 'robots.txt'), 'utf8').includes('Sitemap: https://example.github.io/x402-demand-audit/sitemap.xml'), 'robots.txt points to sitemap');
  const hist = fs.readdirSync(path.join(tmp, 'data', 'history'));
  eq(hist.length, 1, 'one history file per day');
  const s2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'summary.json'), 'utf8'));
  eq(s2.resources_analyzed, fx.items.length - 1, 'summary row count');
  ok(fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').includes('x402 Demand Audit'), 'index.html rendered');
  execFileSync(process.execPath, [path.join(tmp, 'build.mjs'), '--render-only', '--quiet'], { cwd: tmp, stdio: 'pipe' });
  ok(fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').includes('id="reach"'), '--render-only re-renders from data');
  // a typo in the tip address must stop the build
  const bad = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  bad.tip.evm = bad.tip.evm.slice(0, -1) + (bad.tip.evm.endsWith('B') ? 'b' : 'B');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(bad));
  let refused = false;
  try {
    execFileSync(process.execPath, [path.join(tmp, 'build.mjs'), '--render-only', '--quiet'], { cwd: tmp, stdio: 'pipe' });
  } catch {
    refused = true;
  }
  ok(refused, 'build refuses a tip address with a bad checksum');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
