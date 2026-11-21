// Wallet X-Ray — "should my agent pay this address?"
// On-chain profile + payee risk signals for any Base address, sold per call via x402 (USDC on Base).
//
// - Zero dependencies. Single file. Paste into the Cloudflare Workers dashboard as-is (ES module syntax).
// - Also importable from Node >= 18 (see cli.js) — the analysis core is plain fetch + JSON-RPC.
// - Data source: any public Base JSON-RPC (default publicnode, fallback mainnet.base.org). No API keys.
// - Payments: x402 "exact" scheme, v2 (PAYMENT-SIGNATURE) and v1 (X-PAYMENT) clients both accepted,
//   verified + settled through a facilitator (default PayAI; Base mainnet listed in its /supported for v1 "base"
//   and v2 "eip155:8453", checked 2026-11-20). Buyers are only charged when the analysis succeeds.
//
// Env vars (Workers → Settings → Variables):
//   PAY_TO          Base address that receives USDC. REQUIRED: if unset or malformed, /xray answers 503 (fail-closed).
//   FREE_DEMO       set to "1" to deliberately run without PAY_TO (free demo). Never implied by a missing PAY_TO.
//   PRICE_ATOMIC    price in USDC atomic units (6 decimals). Default "10000" = $0.01.
//   FACILITATOR_URL default https://facilitator.payai.network
//   RPC_URLS        comma-separated Base RPC URLs. Default publicnode, mainnet.base.org.
//   RPC_BUDGET      max JSON-RPC subrequests per analysis. Default 44 (Workers free plan allows 50 total).
//
// License: MIT. Author: Dex (f05). Not financial advice: signals are descriptive statistics of public chain data.

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // native USDC on Base (FiatTokenV2_2)
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
export const TOPIC_AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // AuthorizationUsed(address,bytes32) — EIP-3009
export const SEL_BALANCE_OF = '0x70a08231'; // balanceOf(address)
export const DEFAULT_RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];
const BLOCK_TIME_SEC = 2; // Base block time
const DEFAULT_PRICE_ATOMIC = '10000'; // $0.01
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';
const VERSION = '0.1.1';

// ---------------------------------------------------------------- small helpers
const lc = (s) => String(s).toLowerCase();
export const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const hex = (n) => '0x' + Math.max(0, Math.floor(n)).toString(16);
const toNum = (h) => (h == null ? null : Number(BigInt(h)));
const pad32 = (addr) => '0x' + '0'.repeat(24) + lc(addr).slice(2);
const topicToAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function fmtUnits(v, decimals) {
  let neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
const usd = (v) => Number(fmtUnits(v, 6));
const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- JSON-RPC client with subrequest budget
export function makeRpc({ urls = DEFAULT_RPCS, fetchImpl, budget = 44, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  let used = 0;
  let id = 0;
  async function call(method, params) {
    let lastErr;
    for (const url of urls) {
      if (used >= budget) {
        const e = new Error('rpc subrequest budget exhausted');
        e.code = 'BUDGET';
        throw e;
      }
      used++;
      let timer;
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from RPC`);
        const j = await res.json();
        if (j.error) {
          const e = new Error(j.error.message || 'rpc error');
          e.rpc = j.error;
          throw e;
        }
        return j.result;
      } catch (e) {
        lastErr = e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error('rpc failed');
  }
  return { call, used: () => used, budget };
}

// eth_getLogs over [from, to], newest-first, halving the span when the node rejects a range.
// If the budget runs out we keep the most recent data and report exactly what was covered.
// maxLogs caps CPU/JSON work for very busy addresses (Workers free plan = 10ms CPU); coverage is reported.
export async function getLogsAdaptive(rpc, filter, from, to, startSpan = 10000, minSpan = 250, maxLogs = 3000) {
  const logs = [];
  let hi = to;
  let span = Math.max(1, startSpan);
  let complete = true;
  while (hi >= from) {
    if (logs.length >= maxLogs) {
      complete = false;
      break;
    }
    const lo = Math.max(from, hi - span + 1);
    try {
      const got = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: hex(lo), toBlock: hex(hi) }]);
      for (const l of got || []) if (!l.removed) logs.push(l);
      hi = lo - 1;
    } catch (e) {
      if (e.code === 'BUDGET' || span <= minSpan) {
        complete = false;
        break;
      }
      span = Math.floor(span / 2);
    }
  }
  return { logs, scannedFrom: hi + 1, complete: complete && hi < from, span };
}

// Coarse binary search for the first block where predicate(block) is true (predicate is monotonic:
// false ... false true ... true). Needs historical state (archive RPC); returns null if unavailable.
async function firstTrueBlock(rpc, latest, predicate, steps = 12) {
  let lo = 0;
  let hi = latest;
  try {
    for (let i = 0; i < steps && hi - lo > 1; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (await predicate(mid)) hi = mid;
      else lo = mid;
    }
  } catch (e) {
    return { error: e.code === 'BUDGET' ? 'rpc budget exhausted' : 'historical state not available on this RPC (needs archive)' };
  }
  return { lo, hi };
}

// ---------------------------------------------------------------- flow statistics
function parseTransfer(l) {
  return {
    from: topicToAddr(l.topics[1]),
    to: topicToAddr(l.topics[2]),
    value: l.data && l.data !== '0x' ? BigInt(l.data) : 0n,
    block: toNum(l.blockNumber),
    tx: lc(l.transactionHash),
    logIndex: toNum(l.logIndex),
  };
}

function flowStats(list, cpField) {
  const byCp = new Map();
  let total = 0n;
  for (const t of list) {
    total += t.value;
    const k = t[cpField];
    const c = byCp.get(k) || { address: k, count: 0, value: 0n };
    c.count++;
    c.value += t.value;
    byCp.set(k, c);
  }
  const cps = [...byCp.values()].sort((a, b) => cmpBig(b.value, a.value) || b.count - a.count);
  const amounts = list.map((t) => t.value).sort(cmpBig);
  const median = amounts.length ? amounts[Math.floor((amounts.length - 1) / 2)] : 0n;
  return {
    stats: {
      transfers: list.length,
      counterparties: byCp.size,
      total_usdc: usd(total),
      median_usdc: usd(median),
      top_counterparty_share: total > 0n && cps.length ? Number((cps[0].value * 10000n) / total) / 10000 : null,
      top: cps.slice(0, 5).map((c) => ({ address: c.address, transfers: c.count, usdc: usd(c.value) })),
    },
    byCp,
    total,
  };
}

// ---------------------------------------------------------------- the analysis
export async function xray(address, opts = {}) {
  if (!isAddr(address)) {
    const e = new Error('address must be a 0x-prefixed 20-byte hex string');
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();
  const addr = lc(address);
  const rpc = opts.rpc || makeRpc({ urls: opts.urls, fetchImpl: opts.fetchImpl, budget: opts.budget });
  const hours = clamp(Number(opts.hours) || 12, 1, 72);
  const span = opts.span || 10000;

  // 1) current state — 5 calls
  const [bnH, balH, nonceH, code, usdcH] = await Promise.all([
    rpc.call('eth_blockNumber', []),
    rpc.call('eth_getBalance', [addr, 'latest']),
    rpc.call('eth_getTransactionCount', [addr, 'latest']),
    rpc.call('eth_getCode', [addr, 'latest']),
    rpc.call('eth_call', [{ to: USDC, data: SEL_BALANCE_OF + pad32(addr).slice(2) }, 'latest']),
  ]);
  const latest = toNum(bnH);
  const nonce = toNum(nonceH);
  const codeStr = lc(code || '0x');
  let type = 'eoa';
  let delegate = null;
  if (codeStr !== '0x') {
    if (codeStr.startsWith('0xef0100') && codeStr.length === 2 + 6 + 40) {
      type = 'eoa_7702_delegated';
      delegate = '0x' + codeStr.slice(8);
    } else type = 'contract';
  }
  const usdcBal = usdcH && usdcH !== '0x' ? BigInt(usdcH) : 0n;
  const ethBal = balH ? BigInt(balH) : 0n;

  // 2) USDC flows in the window — newest first
  const windowBlocks = Math.round((hours * 3600) / BLOCK_TIME_SEC);
  const from = Math.max(0, latest - windowBlocks + 1);
  const inRes = await getLogsAdaptive(rpc, { address: USDC, topics: [TOPIC_TRANSFER, null, pad32(addr)] }, from, latest, span);
  // one filter returns both outgoing Transfers and EIP-3009 authorizations signed by this address
  const outRes = await getLogsAdaptive(rpc, { address: USDC, topics: [[TOPIC_TRANSFER, TOPIC_AUTH_USED], pad32(addr)] }, from, latest, inRes.span);

  const inbound = inRes.logs.filter((l) => lc(l.topics[0]) === TOPIC_TRANSFER).map(parseTransfer);
  const outbound = outRes.logs.filter((l) => lc(l.topics[0]) === TOPIC_TRANSFER).map(parseTransfer);
  const signedAuths = outRes.logs.filter((l) => lc(l.topics[0]) === TOPIC_AUTH_USED).length;

  // 3) which inbound transfers were EIP-3009 transferWithAuthorization (the x402 "exact" EVM settlement path)?
  //    FiatTokenV2 emits AuthorizationUsed(authorizer, nonce) immediately before Transfer in the same call,
  //    so a match is: same tx, authorizer == transfer.from, logIndex == transfer.logIndex - 1.
  let eip3009Checked = true;
  const authKeys = new Set();
  if (inbound.length) {
    const sendersByCount = new Map();
    for (const t of inbound) sendersByCount.set(t.from, (sendersByCount.get(t.from) || 0) + 1);
    const senders = [...sendersByCount.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    const sample = senders.slice(0, 50);
    if (senders.length > sample.length) eip3009Checked = false; // only top-50 senders checked
    const minB = Math.min(...inbound.map((t) => t.block));
    const maxB = Math.max(...inbound.map((t) => t.block));
    const authRes = await getLogsAdaptive(rpc, { address: USDC, topics: [TOPIC_AUTH_USED, sample.map(pad32)] }, minB, maxB, outRes.span);
    if (!authRes.complete) eip3009Checked = false;
    for (const l of authRes.logs) authKeys.add(`${lc(l.transactionHash)}:${toNum(l.logIndex)}:${topicToAddr(l.topics[1])}`);
  }
  for (const t of inbound) t.eip3009 = authKeys.has(`${t.tx}:${t.logIndex - 1}:${t.from}`);

  const inS = flowStats(inbound, 'from');
  const outS = flowStats(outbound, 'to');
  const eipIn = inbound.filter((t) => t.eip3009);
  const eipPayers = new Set(eipIn.map((t) => t.from));

  // round-tripping: counterparties that both pay this address and get paid by it
  let rtValue = 0n;
  const rtCps = [];
  for (const [cp, c] of inS.byCp) {
    if (cp === addr) continue;
    const back = outS.byCp.get(cp);
    if (back) {
      rtCps.push(cp);
      rtValue += c.value < back.value ? c.value : back.value;
    }
  }
  const rtShare = inS.total > 0n ? Number((rtValue * 10000n) / inS.total) / 10000 : 0;

  // 4) age: first block where the address had outgoing nonce > 0 (EOA) or code (contract)
  let age = { known: false, reason: 'address has never sent a transaction' };
  if (type === 'contract') {
    const r = await firstTrueBlock(rpc, latest, async (b) => lc(await rpc.call('eth_getCode', [addr, hex(b)])) !== '0x');
    age = r.error ? { known: false, reason: r.error } : { known: true, basis: 'first block with deployed code', first_seen_block_between: [r.lo, r.hi], min_age_days: round1(((latest - r.hi) * BLOCK_TIME_SEC) / 86400) };
  } else if (nonce > 0) {
    const r = await firstTrueBlock(rpc, latest, async (b) => toNum(await rpc.call('eth_getTransactionCount', [addr, hex(b)])) > 0);
    age = r.error ? { known: false, reason: r.error } : { known: true, basis: 'first outgoing transaction (nonce > 0)', first_seen_block_between: [r.lo, r.hi], min_age_days: round1(((latest - r.hi) * BLOCK_TIME_SEC) / 86400) };
  }

  const coveredFrom = Math.max(inRes.scannedFrom, outRes.scannedFrom);
  const window = {
    hours_requested: hours,
    from_block: from,
    to_block: latest,
    fully_covered_from_block: coveredFrom,
    complete: inRes.complete && outRes.complete,
    approx_hours_covered: round1(((latest - coveredFrom + 1) * BLOCK_TIME_SEC) / 3600),
  };

  const usdcIn = { ...inS.stats, eip3009_transfers: eipIn.length, eip3009_unique_payers: eipPayers.size, eip3009_usdc: usd(eipIn.reduce((s, t) => s + t.value, 0n)), eip3009_check_complete: eip3009Checked };
  const usdcOut = { ...outS.stats, eip3009_authorizations_signed: signedAuths };

  const { signals, score, verdict } = scoreIt({ type, nonce, ethBal, usdcBal, age, usdcIn, usdcOut, rtShare, rtCps, window });

  return {
    address: addr,
    chain: 'base',
    chain_id: 8453,
    block: latest,
    generated_at: new Date().toISOString(),
    type,
    ...(delegate ? { eip7702_delegate: delegate } : {}),
    balances: { eth: fmtUnits(ethBal, 18), usdc: usd(usdcBal) },
    outgoing_tx_count: type === 'contract' ? null : nonce,
    age,
    window,
    usdc_in: usdcIn,
    usdc_out: usdcOut,
    round_trip: { counterparties: rtCps.length, share_of_inflow: rtShare, addresses: rtCps.slice(0, 5) },
    signals,
    score,
    verdict,
    meta: {
      service: 'wallet-xray',
      version: VERSION,
      rpc_calls: rpc.used(),
      ms: Date.now() - t0,
      notes: [
        'USDC = native Base USDC ' + USDC + '. Flows cover only the scanned window, newest first.',
        'eip3009_* = USDC moved by a signed transferWithAuthorization (the x402 exact-scheme settlement path; also used by some gasless wallets).',
        'Age is a lower bound from a coarse binary search over historical state.',
        'Descriptive statistics of public chain data. Not financial advice.',
      ],
    },
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

export function scoreIt({ type, nonce, ethBal, usdcBal, age, usdcIn, usdcOut, rtShare, rtCps, window }) {
  const signals = [];
  let score = 50;
  const add = (code, level, text, delta = 0) => {
    signals.push({ code, level, text });
    score += delta;
  };

  if (type === 'contract') add('CONTRACT', 'info', 'Address is a smart contract (could be a smart wallet, splitter, or protocol).');
  if (type === 'eoa_7702_delegated') add('EIP7702_DELEGATED', 'info', 'EOA with EIP-7702 delegated code; its behavior depends on the delegate contract.');

  if (age.known) {
    if (age.min_age_days >= 180) add('AGED_180D', 'positive', `Active on Base for at least ${age.min_age_days} days.`, 15);
    else if (age.min_age_days >= 30) add('AGED_30D', 'positive', `Active on Base for at least ${age.min_age_days} days.`, 8);
    else if (age.min_age_days < 7) add('NEW_ADDRESS', 'caution', `First activity is recent (at least ${age.min_age_days} days ago).`, -15);
  } else if (type !== 'contract' && nonce === 0) {
    add('NEVER_SENT_TX', 'caution', 'This address has never sent a transaction, so it has no control history (normal for a fresh receive-only address).', -10);
  } else {
    add('AGE_UNKNOWN', 'info', `Age unknown: ${age.reason}.`);
  }

  if (type !== 'contract' && nonce >= 100) add('ACTIVE_HISTORY', 'positive', `${nonce} outgoing transactions.`, 5);

  if (usdcIn.eip3009_unique_payers >= 20) add('MANY_X402_STYLE_PAYERS', 'positive', `${usdcIn.eip3009_unique_payers} distinct payers sent signed USDC authorizations in the window.`, 15);
  else if (usdcIn.eip3009_unique_payers >= 3) add('RECEIVES_X402_STYLE_PAYMENTS', 'positive', `${usdcIn.eip3009_unique_payers} distinct payers sent signed USDC authorizations in the window.`, 10);

  if (usdcIn.transfers >= 5 && usdcIn.top_counterparty_share !== null && usdcIn.top_counterparty_share > 0.8)
    add('INFLOW_CONCENTRATED', 'warning', `One sender provides ${Math.round(usdcIn.top_counterparty_share * 100)}% of inbound USDC; apparent traction may be self-funded.`, -15);

  if (rtShare > 0.3) add('ROUND_TRIP_FLOWS', 'warning', `${Math.round(rtShare * 100)}% of inbound USDC is matched by USDC sent back to the same ${rtCps.length} counterparties (possible wash volume).`, -20);

  if (usdcOut.eip3009_authorizations_signed > 0) add('SIGNS_X402_STYLE_PAYMENTS', 'info', `Signed ${usdcOut.eip3009_authorizations_signed} USDC transfer authorizations in the window (behaves like an agent/payer wallet).`);

  if (ethBal === 0n && usdcBal === 0n && nonce === 0 && usdcIn.transfers === 0 && type === 'eoa')
    add('EMPTY_ADDRESS', 'caution', 'No balance and no history at all; double-check that this is the intended address.', -10);

  if (!window.complete) add('PARTIAL_WINDOW', 'info', `Only ~${window.approx_hours_covered}h of the requested ${window.hours_requested}h window could be scanned.`);

  score = clamp(Math.round(score), 0, 100);
  const verdict = score >= 70 ? 'established' : score >= 45 ? 'limited_history' : 'caution';
  return { signals, score, verdict };
}

// ---------------------------------------------------------------- x402 paywall (v2 + v1 clients)
const b64e = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64d = (s) => {
  const bin = atob(String(s).trim());
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export function paymentRequirements(env, resourceUrl, description) {
  const amount = String(env.PRICE_ATOMIC || DEFAULT_PRICE_ATOMIC);
  const extra = { name: 'USD Coin', version: '2' }; // EIP-712 domain of Base USDC
  return {
    v2: { scheme: 'exact', network: 'eip155:8453', amount, asset: USDC, payTo: env.PAY_TO, maxTimeoutSeconds: 120, extra },
    v1: { scheme: 'exact', network: 'base', maxAmountRequired: amount, resource: resourceUrl, description, mimeType: 'application/json', payTo: env.PAY_TO, maxTimeoutSeconds: 120, asset: USDC, extra },
  };
}

function paymentRequiredResponse(reqs, resourceUrl, description, error) {
  const v2 = { x402Version: 2, error, resource: { url: resourceUrl, description, mimeType: 'application/json' }, accepts: [reqs.v2] };
  const v1 = { x402Version: 1, error, accepts: [reqs.v1] };
  // v2 clients read the PAYMENT-REQUIRED header; v1 clients read the JSON body.
  return json(v1, 402, { 'PAYMENT-REQUIRED': b64e(JSON.stringify(v2)) });
}

async function facilitatorPost(env, path, body, fetchImpl) {
  const base = String(env.FACILITATOR_URL || DEFAULT_FACILITATOR).replace(/\/+$/, '');
  const res = await fetchImpl(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: j };
}

// Returns { response } to short-circuit, or { free: true }, or { settle } to call after the work succeeds.
export async function x402Gate(request, env, { resourceUrl, description }, fetchImpl = (...a) => globalThis.fetch(...a)) {
  // D-1 fix (review by f03): a missing/misspelled PAY_TO must never silently turn the API free.
  // Free demo is opt-in only (FREE_DEMO=1 and no PAY_TO); a malformed PAY_TO is always a 503.
  if (!env.PAY_TO) {
    if (String(env.FREE_DEMO || '') === '1') return { free: true };
    return { response: json({ error: 'payment not configured', detail: 'PAY_TO is not set; refusing to serve for free (set FREE_DEMO=1 for a deliberate free demo)' }, 503) };
  }
  if (!isAddr(String(env.PAY_TO))) return { response: json({ error: 'payment misconfigured', detail: 'PAY_TO is not a 0x-prefixed 20-byte address' }, 503) };
  const reqs = paymentRequirements(env, resourceUrl, description);
  const header = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT');
  if (!header) return { response: paymentRequiredResponse(reqs, resourceUrl, description, 'payment required') };
  let payload;
  try {
    payload = JSON.parse(b64d(header));
  } catch {
    return { response: paymentRequiredResponse(reqs, resourceUrl, description, 'malformed payment header') };
  }
  const version = payload && payload.x402Version === 2 ? 2 : 1;
  const body = { x402Version: version, paymentPayload: payload, paymentRequirements: version === 2 ? reqs.v2 : reqs.v1 };
  let v;
  try {
    v = await facilitatorPost(env, '/verify', body, fetchImpl);
  } catch (e) {
    return { response: json({ error: 'facilitator unreachable', detail: String(e.message || e) }, 502) };
  }
  if (!v.body || v.body.isValid !== true) {
    return { response: paymentRequiredResponse(reqs, resourceUrl, description, 'payment invalid: ' + ((v.body && v.body.invalidReason) || 'verify failed')) };
  }
  return {
    payer: v.body.payer,
    version,
    settle: async () => {
      let s;
      try {
        s = await facilitatorPost(env, '/settle', body, fetchImpl);
      } catch (e) {
        return { ok: false, response: json({ error: 'facilitator unreachable at settle', detail: String(e.message || e) }, 502) };
      }
      if (!s.body || s.body.success !== true) {
        return { ok: false, response: paymentRequiredResponse(reqs, resourceUrl, description, 'settlement failed: ' + ((s.body && s.body.errorReason) || 'unknown')) };
      }
      const enc = b64e(JSON.stringify(s.body));
      return { ok: true, headers: { 'PAYMENT-RESPONSE': enc, 'X-PAYMENT-RESPONSE': enc }, receipt: s.body };
    },
  };
}

// ---------------------------------------------------------------- HTTP layer
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, payment-signature, x-payment',
  'access-control-expose-headers': 'payment-required, payment-response, x-payment-response',
};

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers } });
}

const DESCRIPTION = 'Wallet X-Ray: on-chain profile and payee risk signals for a Base address (age, balances, USDC in/out flows, x402-style payment history, concentration and round-trip flags, 0-100 score).';

function docs(url, env) {
  const price = Number(env.PRICE_ATOMIC || DEFAULT_PRICE_ATOMIC) / 1e6;
  return {
    service: 'Wallet X-Ray',
    version: VERSION,
    question: 'Should my agent pay this address? Look at its on-chain track record first.',
    endpoint: `${url.origin}/xray/{address}?hours=12`,
    price: env.PAY_TO
      ? `$${price} USDC on Base per call via x402 (exact scheme; v2 PAYMENT-SIGNATURE or v1 X-PAYMENT)`
      : String(env.FREE_DEMO || '') === '1' ? 'FREE demo mode (FREE_DEMO=1, PAY_TO not configured)' : 'UNAVAILABLE: payment not configured (PAY_TO missing); /xray returns 503',
    pay_to: env.PAY_TO || null,
    charged_only_on_success: true,
    params: { hours: 'scan window for USDC flows, 1-72, default 12 (newest first; coverage reported in window.*)' },
    returns: ['type (eoa / contract / eip7702)', 'balances', 'outgoing_tx_count', 'age (lower bound)', 'usdc_in / usdc_out stats with top counterparties', 'eip3009 (x402-style) payments received and signed', 'round_trip', 'signals[]', 'score 0-100', 'verdict'],
    sample: `${url.origin}/sample`,
    data: 'Public Base JSON-RPC only. Not financial advice.',
  };
}

// Synthetic example (from the offline test fixture) so buyers can see the shape before paying.
const SAMPLE = {
  _note: 'SYNTHETIC example: real output of this code run against the offline test fixture (test/test.js), not a real address.',
  address: '0x00000000000000000000000000000000000a11ce',
  type: 'eoa',
  balances: { eth: '0.0021', usdc: 12.5 },
  outgoing_tx_count: 40,
  age: { known: true, basis: 'first outgoing transaction (nonce > 0)', first_seen_block_between: [51489257, 51503906], min_age_days: 196.7 },
  window: { hours_requested: 12, complete: true, approx_hours_covered: 12 },
  usdc_in: { transfers: 9, counterparties: 8, total_usdc: 2.18, median_usdc: 0.01, top_counterparty_share: 0.9174, eip3009_transfers: 6, eip3009_unique_payers: 5, eip3009_usdc: 0.06 },
  usdc_out: { transfers: 2, counterparties: 2, total_usdc: 1.005, eip3009_authorizations_signed: 1 },
  round_trip: { counterparties: 1, share_of_inflow: 0.4587 },
  signals: [
    { code: 'AGED_180D', level: 'positive', text: 'Active on Base for at least 196.7 days.' },
    { code: 'RECEIVES_X402_STYLE_PAYMENTS', level: 'positive', text: '5 distinct payers sent signed USDC authorizations in the window.' },
    { code: 'INFLOW_CONCENTRATED', level: 'warning', text: 'One sender provides 92% of inbound USDC; apparent traction may be self-funded.' },
    { code: 'ROUND_TRIP_FLOWS', level: 'warning', text: '46% of inbound USDC is matched by USDC sent back to the same 1 counterparties (possible wash volume).' },
    { code: 'SIGNS_X402_STYLE_PAYMENTS', level: 'info', text: 'Signed 1 USDC transfer authorizations in the window (behaves like an agent/payer wallet).' },
  ],
  score: 40,
  verdict: 'caution',
};

function rpcUrls(env) {
  return env.RPC_URLS ? String(env.RPC_URLS).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_RPCS;
}

// Coalition gateway adapter (Bolt/Nova contract): handler(env, params) -> JSON. No payment logic here;
// the shared gateway runs x402 and only settles if this resolves. Throws {status:400} on a bad address.
export async function xrayHandler(env = {}, params = {}) {
  return xray(params.address, { urls: rpcUrls(env), hours: params.hours, budget: Number(env.RPC_BUDGET) || 40 });
}

export async function handleXray(request, env, address, url) {
  const resourceUrl = url.origin + url.pathname;
  if (!isAddr(address)) return json({ error: 'invalid address' }, 400);
  const gate = await x402Gate(request, env, { resourceUrl, description: DESCRIPTION });
  if (gate.response) return gate.response;
  let result;
  try {
    result = await xray(address, { urls: rpcUrls(env), hours: url.searchParams.get('hours'), budget: Number(env.RPC_BUDGET) || 44 });
  } catch (e) {
    // not settled => buyer is not charged
    return json({ error: 'analysis_failed', detail: String(e.message || e) }, e.status || 502);
  }
  if (gate.settle) {
    const s = await gate.settle();
    if (!s.ok) return s.response;
    return json(result, 200, s.headers);
  }
  return json(result);
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (url.pathname === '/' || url.pathname === '') return json(docs(url, env));
    if (url.pathname === '/health') return json({ ok: true, version: VERSION });
    if (url.pathname === '/sample') return json(SAMPLE);
    const m = url.pathname.match(/^\/xray\/([^/]+)\/?$/);
    if (m) return handleXray(request, env, m[1], url);
    return json({ error: 'not found', try: '/xray/{address}' }, 404);
  },
};
