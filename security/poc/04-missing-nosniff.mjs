// nosniff header check
//
// Scans API endpoints to see which ones are missing
// X-Content-Type-Options: nosniff. Without it, browsers can
// MIME-sniff JSON as HTML and execute embedded scripts.
//
// Run: node security/poc/04-missing-nosniff.mjs

const TARGET = process.env.TARGET || 'http://localhost:4173';

const endpoints = [
  '/api/firms/status',
  '/api/setup/status',
  '/api/ais-live',
  '/api/route?profile=foot&coords=0,0;1,1',
  '/api/military-installations?south=0&west=0&north=1&east=1',
];

async function main() {
  console.log('checking API endpoints for nosniff header...\n');

  for (const ep of endpoints) {
    try {
      const r = await fetch(TARGET + ep);
      const nosniff = r.headers.get('x-content-type-options');
      const ct = r.headers.get('content-type');
      console.log((nosniff ? 'OK  ' : 'MISS') + '  ' + ep);
      if (!nosniff) console.log('      content-type: ' + ct + ' — no nosniff');
    } catch (e) {
      console.log('ERR   ' + ep + ' — ' + e.message);
    }
  }
}

main();
