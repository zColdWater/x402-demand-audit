// Turns raw Bazaar catalog items into compact rows, neutral concentration flags and aggregate demand statistics.
// Pure functions, no I/O. Every number here is derived from CDP's own 30-day metrics; flags are heuristics, not verdicts.

// Known USDC deployments (6 decimals). Price is only computed for these; anything else is reported as unknown.
export const USDC_ASSETS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'base',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'ethereum',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'arbitrum',
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'optimism',
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'polygon',
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'avalanche',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'base-sepolia',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'solana',
};
const TESTNETS = new Set(['base-sepolia', 'solana-devnet', 'avalanche-fuji', 'polygon-amoy', 'sepolia']);

const NETWORK_ALIASES = {
  'eip155:8453': 'base', base: 'base',
  'eip155:84532': 'base-sepolia', 'base-sepolia': 'base-sepolia',
  'eip155:1': 'ethereum', ethereum: 'ethereum',
  'eip155:11155111': 'sepolia', sepolia: 'sepolia',
  'eip155:42161': 'arbitrum', arbitrum: 'arbitrum',
  'eip155:10': 'optimism', optimism: 'optimism',
  'eip155:137': 'polygon', polygon: 'polygon',
  'eip155:80002': 'polygon-amoy', 'polygon-amoy': 'polygon-amoy',
  'eip155:43114': 'avalanche', avalanche: 'avalanche',
  'eip155:43113': 'avalanche-fuji', 'avalanche-fuji': 'avalanche-fuji',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana', solana: 'solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet', 'solana-devnet': 'solana-devnet',
};
export const normNetwork = (n) => NETWORK_ALIASES[String(n || '')] || String(n || 'unknown');

const num = (x) => {
  const v = Number(x);
  return Number.isFinite(v) && v >= 0 ? v : 0;
};
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const assetKey = (a) => {
  const s = String(a || '');
  return s.startsWith('0x') ? s.toLowerCase() : s;
};

export function priceOf(accepts) {
  // Prefer a mainnet USDC "exact" option; Base first because that is where most x402 volume settles.
  const opts = (Array.isArray(accepts) ? accepts : []).map((a) => {
    const network = normNetwork(a && a.network);
    const usdcNet = USDC_ASSETS[assetKey(a && a.asset)];
    const atomic = a && (a.amount != null ? a.amount : a.maxAmountRequired);
    const usd = usdcNet && atomic != null && /^\d+$/.test(String(atomic)) ? Number(atomic) / 1e6 : null;
    return { network, scheme: String((a && a.scheme) || ''), usd, testnet: TESTNETS.has(network), payTo: a && a.payTo ? String(a.payTo) : null };
  });
  const priced = opts.filter((o) => o.usd !== null && !o.testnet);
  const pick =
    priced.find((o) => o.network === 'base' && o.scheme === 'exact') ||
    priced.filter((o) => o.scheme === 'exact').sort((a, b) => a.usd - b.usd)[0] ||
    priced.sort((a, b) => a.usd - b.usd)[0] ||
    null;
  const basePay = opts.find((o) => o.network === 'base' && o.payTo);
  return {
    price_usd: pick ? pick.usd : null,
    price_scheme: pick ? pick.scheme : null,
    networks: [...new Set(opts.map((o) => o.network))].sort(),
    pay_to: basePay ? basePay.payTo : (opts.find((o) => o.payTo) || {}).payTo || null,
    pay_to_network: basePay ? 'base' : (opts.find((o) => o.payTo) || {}).network || null,
    testnet_only: opts.length > 0 && opts.every((o) => o.testnet),
  };
}

export function hostOf(resource) {
  try {
    return new URL(String(resource)).host.toLowerCase();
  } catch {
    return '';
  }
}

export function toRow(item) {
  const q = (item && item.quality) || {};
  const p = priceOf(item && item.accepts);
  const calls = num(q.l30DaysTotalCalls);
  const payers = num(q.l30DaysUniquePayers);
  const meta = (item && item.metadata) || {};
  const tags = Array.isArray(item && item.tags) ? item.tags : Array.isArray(meta.tags) ? meta.tags : [];
  return {
    resource: clip(item && item.resource, 300),
    host: hostOf(item && item.resource),
    service: clip((item && item.serviceName) || meta.serviceName || '', 80),
    description: clip((item && item.description) || meta.description || (item && item.accepts && item.accepts[0] && item.accepts[0].description) || '', 160),
    tags: tags.map((t) => clip(t, 32).toLowerCase()).filter(Boolean).slice(0, 8),
    curated: !!(item && item.curated),
    price_usd: p.price_usd,
    price_scheme: p.price_scheme,
    networks: p.networks,
    pay_to: p.pay_to,
    pay_to_network: p.pay_to_network,
    testnet_only: p.testnet_only,
    calls_30d: calls,
    payers_30d: payers,
    calls_per_payer: payers > 0 ? Math.round((calls / payers) * 100) / 100 : null,
    last_called_at: q.lastCalledAt || null,
    last_updated: (item && item.lastUpdated) || null,
    flags: [],
  };
}

// Neutral, descriptive flags. None of them proves wrongdoing: a B2B integration can legitimately be one payer
// calling a lot, and a batch of first-time trials can look like "one call per payer".
export const FLAG_TEXT = {
  HIGH_CONCENTRATION: 'At least 1,000 calls and 100+ calls per unique payer: volume comes from a small set of wallets.',
  LOCKSTEP_CALLS: '4+ endpoints of the same payTo have near-identical 30-day call counts (within 3%), consistent with scripted round-robin calling.',
  ONE_SHOT_PAYERS: '100+ unique payers but about one call each: consistent with one-off trials or many fresh wallets; worth an on-chain look.',
  SINGLE_PAYER: 'One unique payer (or none) in 30 days.',
  STALE_7D: 'No paid call in the last 7 days.',
};

export function applyFlags(rows, nowMs) {
  for (const r of rows) {
    const f = [];
    if (r.payers_30d > 0 && r.calls_30d >= 1000 && r.calls_30d / r.payers_30d >= 100) f.push('HIGH_CONCENTRATION');
    if (r.payers_30d >= 100 && r.calls_30d / r.payers_30d <= 1.05) f.push('ONE_SHOT_PAYERS');
    if (r.payers_30d <= 1) f.push('SINGLE_PAYER');
    const t = Date.parse(r.last_called_at || '');
    if (Number.isFinite(t) && nowMs - t > 7 * 864e5) f.push('STALE_7D');
    r.flags = f;
  }
  // LOCKSTEP: group by payTo, look at endpoints with >= 1000 calls.
  const groups = new Map();
  for (const r of rows) {
    if (!r.pay_to || r.calls_30d < 1000) continue;
    const k = r.pay_to.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const lockstep = [];
  for (const [payTo, g] of groups) {
    if (g.length < 4) continue;
    const calls = g.map((r) => r.calls_30d).sort((a, b) => a - b);
    const med = calls[Math.floor(calls.length / 2)];
    // largest cluster within ±3% of the median
    const cluster = g.filter((r) => Math.abs(r.calls_30d - med) <= med * 0.03);
    if (cluster.length >= 4) {
      for (const r of cluster) if (!r.flags.includes('LOCKSTEP_CALLS')) r.flags.push('LOCKSTEP_CALLS');
      lockstep.push({
        pay_to: g[0].pay_to,
        hosts: [...new Set(cluster.map((r) => r.host))].slice(0, 5),
        endpoints: cluster.length,
        median_calls_30d: med,
        sum_calls_30d: cluster.reduce((s, r) => s + r.calls_30d, 0),
        max_payers_30d: Math.max(...cluster.map((r) => r.payers_30d)),
      });
    }
  }
  lockstep.sort((a, b) => b.sum_calls_30d - a.sum_calls_30d);
  return { lockstep };
}

export function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.resource;
    const prev = seen.get(k);
    if (!prev || (r.last_updated || '') > (prev.last_updated || '')) seen.set(k, r);
  }
  return [...seen.values()];
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const share = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : 0);

export const PAYER_BUCKETS = [
  { key: '0-1', min: 0, max: 1 },
  { key: '2-9', min: 2, max: 9 },
  { key: '10-99', min: 10, max: 99 },
  { key: '100-999', min: 100, max: 999 },
  { key: '1000+', min: 1000, max: Infinity },
];
export const PRICE_BUCKETS = [
  { key: '<= $0.001', max: 0.001 },
  { key: '$0.001-0.005', max: 0.005 },
  { key: '$0.005-0.01', max: 0.01 },
  { key: '$0.01-0.05', max: 0.05 },
  { key: '$0.05-0.10', max: 0.1 },
  { key: '$0.10-1', max: 1 },
  { key: '> $1', max: Infinity },
];

const slim = (r) => ({
  resource: r.resource,
  host: r.host,
  service: r.service,
  description: r.description,
  price_usd: r.price_usd,
  networks: r.networks,
  pay_to: r.pay_to,
  calls_30d: r.calls_30d,
  payers_30d: r.payers_30d,
  calls_per_payer: r.calls_per_payer,
  last_called_at: r.last_called_at,
  flags: r.flags,
  tags: r.tags,
});

export function analyze(rawRows, { nowMs = Date.now(), listedTotal = null, top = 50 } = {}) {
  const rows = dedupe(rawRows).filter((r) => r.resource);
  const { lockstep } = applyFlags(rows, nowMs);
  const mainnet = rows.filter((r) => !r.testnet_only);
  const totalCalls = mainnet.reduce((s, r) => s + r.calls_30d, 0);
  const totalPairs = mainnet.reduce((s, r) => s + r.payers_30d, 0);

  const payerDist = PAYER_BUCKETS.map((b) => {
    const rs = mainnet.filter((r) => r.payers_30d >= b.min && r.payers_30d <= b.max);
    const c = rs.reduce((s, r) => s + r.calls_30d, 0);
    return { bucket: b.key, resources: rs.length, share_of_resources: share(rs.length, mainnet.length), calls_30d: c, share_of_calls: share(c, totalCalls) };
  });

  const priced = mainnet.filter((r) => r.price_usd !== null);
  const priceDist = [];
  let lo = -Infinity;
  for (const b of PRICE_BUCKETS) {
    const rs = priced.filter((r) => r.price_usd > lo && r.price_usd <= b.max);
    lo = b.max;
    const withReach = rs.filter((r) => r.payers_30d >= 10);
    priceDist.push({
      bucket: b.key,
      resources: rs.length,
      with_10plus_payers: withReach.length,
      share_with_10plus_payers: share(withReach.length, rs.length),
      median_payers_30d: median(rs.map((r) => r.payers_30d)),
      payer_endpoint_pairs: rs.reduce((s, r) => s + r.payers_30d, 0),
    });
  }

  const flagged = (code) => mainnet.filter((r) => r.flags.includes(code));
  const conc = flagged('HIGH_CONCENTRATION');
  const lock = flagged('LOCKSTEP_CALLS');
  const inflated = mainnet.filter((r) => r.flags.includes('HIGH_CONCENTRATION') || r.flags.includes('LOCKSTEP_CALLS'));
  const inflatedCalls = inflated.reduce((s, r) => s + r.calls_30d, 0);

  const tagAgg = new Map();
  for (const r of mainnet) {
    for (const t of r.tags) {
      const a = tagAgg.get(t) || { tag: t, resources: 0, payer_endpoint_pairs: 0, calls_30d: 0, with_10plus_payers: 0 };
      a.resources++;
      a.payer_endpoint_pairs += r.payers_30d;
      a.calls_30d += r.calls_30d;
      if (r.payers_30d >= 10) a.with_10plus_payers++;
      tagAgg.set(t, a);
    }
  }
  const tags = [...tagAgg.values()].sort((a, b) => b.payer_endpoint_pairs - a.payer_endpoint_pairs).slice(0, 30);

  const netAgg = new Map();
  for (const r of mainnet) for (const n of r.networks) netAgg.set(n, (netAgg.get(n) || 0) + 1);
  const networks = [...netAgg.entries()].map(([network, resources]) => ({ network, resources, share: share(resources, mainnet.length) })).sort((a, b) => b.resources - a.resources);

  const payToAgg = new Map();
  for (const r of mainnet) {
    if (!r.pay_to) continue;
    const k = r.pay_to.toLowerCase();
    const a = payToAgg.get(k) || { pay_to: r.pay_to, hosts: new Set(), endpoints: 0, calls_30d: 0, max_payers_30d: 0 };
    a.hosts.add(r.host);
    a.endpoints++;
    a.calls_30d += r.calls_30d;
    a.max_payers_30d = Math.max(a.max_payers_30d, r.payers_30d);
    payToAgg.set(k, a);
  }
  const sellers = [...payToAgg.values()].map((a) => ({ ...a, hosts: [...a.hosts].slice(0, 4) }));
  sellers.sort((a, b) => b.calls_30d - a.calls_30d);

  const byPayers = [...mainnet].sort((a, b) => b.payers_30d - a.payers_30d || b.calls_30d - a.calls_30d);
  const byCalls = [...mainnet].sort((a, b) => b.calls_30d - a.calls_30d || b.payers_30d - a.payers_30d);
  const reach10 = mainnet.filter((r) => r.payers_30d >= 10);

  const summary = {
    generated_at: new Date(nowMs).toISOString(),
    listed_total: listedTotal,
    resources_analyzed: rows.length,
    coverage: listedTotal ? share(rows.length, listedTotal) : null,
    mainnet_resources: mainnet.length,
    testnet_only_resources: rows.length - mainnet.length,
    distinct_pay_to: payToAgg.size,
    calls_30d: totalCalls,
    payer_endpoint_pairs_30d: totalPairs,
    headline: {
      share_resources_le1_payer: share(payerDist[0].resources, mainnet.length),
      resources_10plus_payers: reach10.length,
      share_resources_10plus_payers: share(reach10.length, mainnet.length),
      resources_100plus_payers: mainnet.filter((r) => r.payers_30d >= 100).length,
      share_calls_top10_resources: share(byCalls.slice(0, 10).reduce((s, r) => s + r.calls_30d, 0), totalCalls),
      share_calls_concentrated_or_lockstep: share(inflatedCalls, totalCalls),
      high_concentration_resources: conc.length,
      lockstep_resources: lock.length,
      lockstep_groups: lockstep.length,
      median_price_usd_10plus_payers: median(reach10.filter((r) => r.price_usd !== null).map((r) => r.price_usd)),
      median_price_usd_all: median(priced.map((r) => r.price_usd)),
    },
    payer_distribution: payerDist,
    price_vs_reach: priceDist,
    tags,
    networks,
    lockstep_groups: lockstep.slice(0, 20),
    top_by_payers: byPayers.slice(0, top).map(slim),
    top_by_calls: byCalls.slice(0, top).map(slim),
    most_concentrated: [...conc].sort((a, b) => b.calls_30d - a.calls_30d).slice(0, 30).map(slim),
    top_sellers_by_calls: sellers.slice(0, 25),
    flag_definitions: FLAG_TEXT,
  };
  return { rows, summary };
}

// CSV with formula-injection guard (cells starting with = + - @ are prefixed with a quote, per OWASP).
export function toCsv(rows) {
  const cols = ['resource', 'host', 'service', 'price_usd', 'networks', 'pay_to', 'calls_30d', 'payers_30d', 'calls_per_payer', 'last_called_at', 'flags', 'tags'];
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join('|') : v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const sorted = [...rows].sort((a, b) => b.payers_30d - a.payers_30d || b.calls_30d - a.calls_30d);
  return [cols.join(','), ...sorted.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
