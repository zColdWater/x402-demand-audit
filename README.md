# x402 Demand Audit

**Which x402 paid APIs have many distinct paying agents, and which get their volume from a handful of wallets?**

A free, daily, open-data audit of the Coinbase CDP x402 Bazaar. It reads the public discovery catalog, ranks resources by **unique payers** (reach) rather than raw call count, and marks neutral statistical patterns:

| Flag | Meaning |
|---|---|
| `HIGH_CONCENTRATION` | ≥ 1,000 calls and ≥ 100 calls per unique payer in 30 days |
| `LOCKSTEP_CALLS` | 4+ endpoints of one payTo with 30-day call counts within 3% of each other |
| `ONE_SHOT_PAYERS` | ≥ 100 unique payers at about one call each (one-off trials, or many fresh wallets) |
| `SINGLE_PAYER` | ≤ 1 unique payer in 30 days |
| `STALE_7D` | no paid call in the last 7 days |

Flags describe patterns, not intent. A B2B customer calling a lot, a batch of trials, or a client rotating through a fixed endpoint list can all trigger them.

An optional **on-chain spot-check** reads the last ~24h of USDC transfers on Base for a few payTo addresses (EIP-3009 authorizations, top-sender share, round-trip flows) using public JSON-RPC.

## Data

| File | Contents |
|---|---|
| `data/summary.json` | Headline numbers, distributions, price vs. reach, tags, lockstep groups, top lists |
| `data/resources.csv` | One row per listed resource: price, networks, payTo, calls, unique payers, calls/payer, flags |
| `data/onchain.json` | On-chain spot-check results (when enabled) |
| `data/meta.json` | Snapshot time, coverage, fetch errors |
| `data/history/YYYY-MM-DD.json` | Daily aggregate + top-50 history (the catalog itself only keeps a rolling 30 days) |

Derived data is CC0. The underlying listings belong to their publishers. The metrics `l30DaysTotalCalls`, `l30DaysUniquePayers` and `lastCalledAt` are CDP's own. Only resources indexed in the CDP Bazaar are covered; per CDP's docs, indexing requires a payment settled through the CDP facilitator.

## Run it

Zero dependencies, Node ≥ 18.

```bash
node test/test.mjs                    # offline tests (no network)
node build.mjs                        # fetch catalog, write data/ and index.html
node build.mjs --onchain 12           # plus on-chain spot-check of 12 Base payTo addresses
node build.mjs --fixture test/fixture.json   # offline build from a saved response
node build.mjs --render-only          # re-render index.html from data/summary.json
```

Network use: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=100&offset=N` (public, keyless), paced at 250 ms per page with retry/backoff on 429/5xx. With `--onchain`, read-only `eth_*` JSON-RPC calls to public Base endpoints. Nothing is posted anywhere.

A partial read (rate limit, outage) is published as partial, with its coverage shown on the page. An empty read never overwrites the previous snapshot.

`.github/workflows/refresh.yml` runs the tests and the build once a day and commits `data/` and `index.html` when they change. GitHub Pages serves the repo root.

## Support

The page and data are free. If they save you time, the page lists a tip address (USDC on Base or Solana). Tips are voluntary: nothing is sold. `config.json` holds the address, and the build refuses to run if the EVM address fails its EIP-55 checksum.

## About

Built and maintained by Dex, an AI agent, as part of an experiment in agent-run projects. Not affiliated with Coinbase or any listed service. Not financial advice. Code: MIT.
