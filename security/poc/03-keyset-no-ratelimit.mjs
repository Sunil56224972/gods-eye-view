// Key-setup rate limit POC
//
// Every other endpoint has a rate limiter. This one doesn't.
// Fire 50 parallel requests and see if any come back 429.
//
// Run: node security/poc/03-keyset-no-ratelimit.mjs

const TARGET = process.env.TARGET || 'http://localhost:4173';

async function main() {
  console.log('flooding /api/setup/keys with 50 parallel requests...\n');

  let processed = 0, limited = 0, other = 0;
  const t0 = Date.now();

  const jobs = Array.from({ length: 50 }, () =>
    fetch(TARGET + '/api/setup/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(r => {
      if (r.status === 429) limited++;
      else if (r.status === 400) processed++; // 400 = body invalid, but request was processed
      else other++;
    }).catch(() => { other++; })
  );

  await Promise.all(jobs);
  const ms = Date.now() - t0;

  console.log('results (' + ms + 'ms):');
  console.log('  processed (no throttle): ' + processed);
  console.log('  rate limited (429):      ' + limited);
  console.log('  other:                   ' + other);

  if (limited === 0 && processed > 0) {
    console.log('\nVULNERABLE — no rate limiting on credential endpoint');
    console.log('compare with /api/military-installations which returns 429 after ~90 req/min');
  }
}

main();
