/**
 * POC #6 — OpenAI token minting has no access control
 *
 * The /api/realtime/token endpoint uses the server's secret OPENAI_API_KEY
 * to mint ephemeral session tokens. Before the fix, it had zero access
 * control — no loopback check, no origin validation, nothing. The key-setup
 * endpoints that MANAGE the key have 9 layers of defense, but the endpoint
 * that actually SPENDS it was wide open.
 *
 * Impact: with HOST=0.0.0.0 (recommended in the docs for LAN sharing),
 * any device on the network can:
 *   1. GET /api/realtime/token → receive a working OpenAI session token
 *   2. Use that token for any OpenAI API call
 *   3. Each call bills the server owner's account
 *   4. At 30 req/min (rate limit default), that's 43,200 tokens/day
 *
 * Same applies to /api/openai/hud-summary — each POST costs tokens.
 *
 * Run: node security/poc/06-token-no-access-control.mjs [host] [port]
 *
 * BEFORE fix: shows 200 OK + token or 503 (no key) from LAN IPs
 * AFTER fix:  shows 403 Forbidden from any non-loopback address
 */

const host = process.argv[2] || 'localhost';
const port = process.argv[3] || '4173';
const base = `http://${host}:${port}`;

async function probe(label, url, options = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
    const body = await res.text();
    const short = body.length > 120 ? body.slice(0, 120) + '...' : body;
    console.log(`  ${label}: HTTP ${res.status} — ${short}`);
    return res.status;
  } catch (err) {
    console.log(`  ${label}: FAILED — ${err.message}`);
    return 0;
  }
}

console.log(`\n=== POC #6: Token minting access control ===\n`);
console.log(`Target: ${base}`);
console.log(`Testing from: ${host === 'localhost' ? 'loopback (should work)' : 'LAN IP (should be blocked after fix)'}\n`);

console.log('1. Token endpoint (GET /api/realtime/token):');
const tokenStatus = await probe('realtime/token', `${base}/api/realtime/token`);

console.log('\n2. HUD summary endpoint (POST /api/openai/hud-summary):');
const hudStatus = await probe('hud-summary', `${base}/api/openai/hud-summary`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ place: 'test', layers: [] }),
});

console.log('\n3. Rapid-fire token minting (5 requests):');
const results = [];
for (let i = 0; i < 5; i++) {
  const s = await probe(`  mint #${i + 1}`, `${base}/api/realtime/token`);
  results.push(s);
}

console.log('\n--- Analysis ---');
if (tokenStatus === 403 || hudStatus === 403) {
  console.log('PASS: endpoints correctly reject this caller (loopback guard active)');
} else if (tokenStatus === 200) {
  console.log('FAIL: token endpoint returned a working token without access control');
  console.log('      An attacker on the LAN can mint OpenAI tokens at will');
} else if (tokenStatus === 503) {
  console.log('NOTE: no OPENAI_API_KEY configured — endpoint reachable but no key to steal');
  console.log('      With a key configured, this would return a working token');
} else {
  console.log(`Unexpected status ${tokenStatus} — manual review needed`);
}

console.log('\nTo test the LAN attack scenario:');
console.log('  1. Start the server with HOST=0.0.0.0');
console.log('  2. Find the LAN IP (e.g. 192.168.1.x)');
console.log(`  3. Run: node security/poc/06-token-no-access-control.mjs 192.168.1.x ${port}`);
console.log('  Before fix: 200/503. After fix: 403.\n');
