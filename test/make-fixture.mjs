// Generates test/fixture.json: a catalog response with the same shape as the CDP discovery API
// (items[] + pagination + x402Version). Numbers mirror the first page read on 2026-11-21; hosts and
// addresses are anonymized because this is test data, not a published finding.
import fs from 'node:fs';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const item = (resource, amount, calls, payers, last, { payTo = addr(1), tags = [], service = '', description = '', extra = [] } = {}) => ({
  resource, type: 'http', x402Version: 2,
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: String(amount), asset: USDC_BASE, payTo, maxTimeoutSeconds: 60 }, ...extra],
  lastUpdated: '2026-11-20T20:00:00.000Z',
  quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: payers, lastCalledAt: last },
  serviceName: service, description, tags,
});
const items = [
  item('https://exec-a.example/api/send-native', 50000, 13266, 4505, '2026-11-20T18:12:38Z', { payTo: addr(0xa1), tags: ['payments'], service: 'Exec A' }),
  item('https://exec-a.example/api/send-token', 50000, 13355, 4619, '2026-11-20T18:12:49Z', { payTo: addr(0xa1), tags: ['payments'], service: 'Exec A' }),
  item('https://grade-b.example/api/verdict', 20000, 88497, 621, '2026-11-20T18:31:40Z', { payTo: addr(0xb1), tags: ['crypto', 'ai'] }),
  item('https://weather-c.example/weather/current', 2000, 1121, 367, '2026-11-20T12:56:04Z', { payTo: addr(0xc1), tags: ['weather'] }),
  ...['quote', 'ping', 'network', 'time', 'uuid', 'payment', 'random', 'ip', 'status'].map((p, i) =>
    item(`https://trivial-d.example/x402/${p}`, 5000, [43947, 44309, 43839, 43892, 43876, 43992, 43845, 43833, 43898][i], [127, 141, 139, 137, 128, 125, 123, 123, 120][i], '2026-11-20T18:20:40Z', { payTo: addr(0xd1), tags: ['utility'] })),
  item('https://trivial-d.example/x402/rewrite', 10000000, 250, 95, '2026-11-20T18:16:58Z', { payTo: addr(0xd1), tags: ['ai'] }),
  item('https://search-e.example/search', 7000, 13329, 149, '2026-11-20T18:21:21Z', { payTo: addr(0xe1), tags: ['search'], extra: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '7000', asset: USDC_SOL, payTo: 'So1anaPayTo1111111111111111111111111111111' }] }),
  item('https://llm-f.example/v1/chat/completions', 2000, 75992, 284, '2026-11-20T18:25:35Z', { payTo: addr(0xf1), tags: ['ai', 'llm'] }),
  item('https://chain-g.example/api/erc20-balance', 3000, 743, 730, '2026-11-19T21:02:40Z', { payTo: addr(0x61), tags: ['blockchain', 'data'] }),
  item('https://chain-g.example/api/block-number', 1000, 735, 646, '2026-11-20T16:03:59Z', { payTo: addr(0x61), tags: ['blockchain', 'data'] }),
  item('https://chain-g.example/api/contract/:address', 5000, 530, 530, '2026-11-13T04:00:34Z', { payTo: addr(0x61), tags: ['blockchain', 'data'] }),
  item('https://social-h.example/api/v1/twitter/search', 5000, 11960, 28, '2026-11-20T18:00:03Z', { payTo: addr(0x71), tags: ['social'] }),
  item('https://lonely-i.example/one', 1000, 3, 1, '2026-11-10T00:00:00Z', { payTo: addr(0x81) }),
  // v1-style entry (network name + maxAmountRequired), no quality block at all
  { resource: 'https://v1-j.example/data', type: 'http', x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '10000', asset: USDC_BASE, payTo: addr(0x91), description: 'v1 description' }], lastUpdated: '2026-11-19T00:00:00Z' },
  // testnet only
  item('https://testnet-k.example/t', 1000, 50, 5, '2026-11-20T00:00:00Z', { payTo: addr(0x92) }),
  // unknown asset (not USDC)
  { resource: 'https://odd-l.example/x', type: 'http', x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '5', asset: addr(0xdead), payTo: addr(0x93) }], quality: { l30DaysTotalCalls: 12, l30DaysUniquePayers: 4, lastCalledAt: '2026-11-20T00:00:00Z' } },
  // hostile text: must be escaped everywhere
  item('https://xss-m.example/<script>alert(1)</script>', 1000, 20, 12, '2026-11-20T00:00:00Z', { payTo: addr(0x94), service: '<img src=x onerror=alert(2)>', description: '"><script>alert(3)</script> =cmd|calc', tags: ['<b>tag</b>'] }),
];
// make the testnet item really testnet
items.find((i) => i.resource.includes('testnet-k')).accepts = [{ scheme: 'exact', network: 'eip155:84532', amount: '1000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: addr(0x92) }];
// duplicate resource (catalog shifted between pages): newer lastUpdated must win
items.push({ ...items[3], lastUpdated: '2026-11-20T21:00:00.000Z', quality: { ...items[3].quality, l30DaysTotalCalls: 1130 } });
fs.writeFileSync(new URL('./fixture.json', import.meta.url), JSON.stringify({ items, pagination: { limit: 100, offset: 0, total: items.length - 1 }, x402Version: 2 }, null, 1) + '\n');
console.log('wrote fixture with', items.length, 'items');
