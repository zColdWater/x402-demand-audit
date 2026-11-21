// Optional on-chain spot-check: for a handful of Base payTo addresses, look at the last ~24h of USDC inflows
// with Wallet X-Ray (same code as the paid API, vendored in lib/wallet-xray.js) and compare with what the catalog claims.
// Read-only public JSON-RPC calls, no keys. Every failure is recorded per address and never breaks the build.

import { xray } from './wallet-xray.js';

const isEvm = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export function pickTargets(summary, rows, n = 12) {
  const half = Math.max(1, Math.ceil(n / 2));
  const seen = new Set();
  const out = [];
  const add = (r, why) => {
    if (!r || !isEvm(r.pay_to) || r.pay_to_network !== 'base') return false;
    const k = r.pay_to.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    out.push({ pay_to: r.pay_to, why, host: r.host, catalog_calls_30d: r.calls_30d, catalog_payers_30d: r.payers_30d });
    return true;
  };
  const inflated = rows
    .filter((r) => !r.testnet_only && (r.flags.includes('HIGH_CONCENTRATION') || r.flags.includes('LOCKSTEP_CALLS')))
    .sort((a, b) => b.calls_30d - a.calls_30d);
  let k = 0;
  for (const r of inflated) {
    if (k >= half) break;
    if (add(r, 'high volume, concentrated')) k++;
  }
  const reach = rows.filter((r) => !r.testnet_only).sort((a, b) => b.payers_30d - a.payers_30d);
  for (const r of reach) {
    if (out.length >= n) break;
    add(r, 'most unique payers');
  }
  return out;
}

export async function spotCheck(targets, { hours = 24, budget = 40, totalBudgetMs = 8 * 60 * 1000, urls, fetchImpl, log = () => {} } = {}) {
  const t0 = Date.now();
  const results = [];
  for (const t of targets) {
    if (Date.now() - t0 > totalBudgetMs) {
      results.push({ ...t, status: 'skipped', error: 'time budget exhausted' });
      continue;
    }
    try {
      const r = await xray(t.pay_to, { hours, budget, urls, fetchImpl });
      const signals = (r.signals || []).map((s) => s.code);
      results.push({
        ...t,
        status: 'ok',
        type: r.type,
        window_hours_covered: r.window ? r.window.approx_hours_covered : null,
        window_complete: r.window ? !!r.window.complete : null,
        onchain_usdc_in_transfers: r.usdc_in ? r.usdc_in.transfers : null,
        onchain_eip3009_payments: r.usdc_in ? r.usdc_in.eip3009_transfers : null,
        onchain_eip3009_unique_payers: r.usdc_in ? r.usdc_in.eip3009_unique_payers : null,
        onchain_top_sender_share: r.usdc_in ? r.usdc_in.top_counterparty_share : null,
        onchain_round_trip_share: r.round_trip ? r.round_trip.share_of_inflow : null,
        signals,
        score: r.score,
        verdict: r.verdict,
      });
      log(`onchain ${t.pay_to}: ok (${signals.join(',') || 'no signals'})`);
    } catch (e) {
      results.push({ ...t, status: 'error', error: String((e && e.message) || e).slice(0, 200) });
      log(`onchain ${t.pay_to}: error ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
  return { generated_at: new Date().toISOString(), hours, results };
}
