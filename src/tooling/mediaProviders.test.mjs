import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cctvProxy,
  resolveStreetViewPose,
  STREETVIEW_DEFAULT_PER_MIN,
} from '../../server/providers/cctv.js';
import { radioBrowserProxy } from '../../server/providers/radio.js';
import { localProviderPlugins } from '../../server/providers/local.js';

function install(plugin, hook = 'configureServer') {
  let handler;
  plugin[hook]({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url, headers = {}) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler(
      {
        url,
        method: 'GET',
        headers: { host: 'localhost:4173', ...headers },
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
    );
    return res;
  };
}

function fixture(t, id) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify([
      {
        id,
        name: '<Camera & test>',
        lat: 30.27,
        lon: -97.74,
        feedType: 'video',
      },
    ]),
  );
  return root;
}

function isolate(t) {
  for (const name of [
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
  ]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('fixture must not fetch');
  });
}

test('CCTV instances resolve their own application source root and isolate catalogs and health', async (t) => {
  isolate(t);
  const first = install(cctvProxy({ sourceRoot: fixture(t, 'first') }));
  const second = install(cctvProxy({ sourceRoot: fixture(t, 'second') }));
  const [a, b] = await Promise.all([first('/sources'), second('/sources')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(
    JSON.parse(a.body).sources.map((s) => s.id),
    ['first'],
  );
  assert.deepEqual(
    JSON.parse(b.body).sources.map((s) => s.id),
    ['second'],
  );
  const stream = JSON.parse((await first('/stream/first')).body);
  assert.equal(stream.feedType, 'mp4');
  assert.equal(stream.mediaUrl, '/api/cctv/media/first');
  assert.equal((await first('/media/first')).status, 404);
  const frame = await first('/frame/first');
  assert.equal(frame.headers['X-CCTV-Source'], 'synthetic');
  assert.match(frame.body, /&lt;Camera &amp; test&gt;/);
  assert.equal(JSON.parse((await first('/health')).body).cameras.length, 1);
  assert.deepEqual(JSON.parse((await second('/health')).body).cameras, []);
});

test('composition creates exactly one CCTV and radio provider without acquisition', (t) => {
  isolate(t);
  const plugins = localProviderPlugins();
  for (const factory of [cctvProxy, radioBrowserProxy]) {
    assert.equal(plugins.filter((p) => p.name === factory().name).length, 1);
  }
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`CCTV ${hook} maps header timeouts and cancels upstream error bodies`, async (t) => {
    isolate(t);
    process.env.CCTV_SOURCES_JSON = JSON.stringify([
      {
        id: 'bounded',
        name: 'Test',
        lat: 30,
        lon: -97,
        feedType: 'video',
        url: 'https://camera.example.org/live.mp4',
      },
    ]);
    const request = install(
      cctvProxy({ sourceRoot: fixture(t, 'unused') }),
      hook,
    );
    // Resolve the catalog before substituting transport behavior.
    await request('/sources');
    t.mock.method(globalThis, 'fetch', async () => {
      throw new DOMException('timeout', 'AbortError');
    });
    const timeout = await request('/media/bounded');
    assert.equal(timeout.status, 504);
    assert.deepEqual(JSON.parse(timeout.body), {
      error: 'Upstream media timeout',
    });
    let cancelled = false;
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    );
    const error = await request('/media/bounded');
    assert.equal(error.status, 503);
    assert.equal(cancelled, true);
  });
}

test('a failed CCTV media fetch reports a fixed health message, not the error text', async (t) => {
  isolate(t);
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify([
      {
        id: 'leaky',
        name: 'Leaky camera',
        lat: 30.27,
        lon: -97.74,
        feedType: 'video',
        url: 'https://cams.fixture.invalid/leaky.m3u8',
      },
    ]),
  );
  const leak =
    'connect ETIMEDOUT 203.0.113.9:443 C:\fixture\secret-path\cams.json';
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', () => {
    throw Error(leak);
  });

  const call = install(cctvProxy({ sourceRoot: root }));
  const media = await call('/media/leaky');
  assert.equal(media.status, 502);
  assert.equal(media.body.includes('203.0.113.9'), false);

  // GET /health is the second door: src/layers/cctv/frames.js renders each
  // entry's `message` as the camera's status label, so a raw errno stored here
  // reaches the screen even though the response above is sanitized.
  const camera = JSON.parse((await call('/health')).body).cameras.find(
    (entry) => entry.id === 'leaky',
  );
  assert.equal(camera.status, 'degraded');
  assert.equal(camera.message, 'Media fetch failed');
  assert.equal(camera.message.includes('ETIMEDOUT'), false);
  assert.equal(camera.message.includes('secret-path'), false);
});

/** Mount a CCTV proxy with one keyless registered camera and a Street View spy. */
async function streetViewHarness(t, env = {}) {
  isolate(t);
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'server-key-fixture';
  for (const name of ['GEV_RATELIMIT_GOOGLE_PER_MIN']) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    { id: 'eiffel', name: 'Registered', lat: 48.8584, lon: 2.2945 },
  ]);
  const request = install(cctvProxy({ sourceRoot: fixture(t, 'unused') }));
  await request('/sources');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    calls.push(new URL(String(input)));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  });
  return { request, calls };
}

test('Street View fallback never spends the server key on an unregistered camera id', async (t) => {
  const { request, calls } = await streetViewHarness(t);
  for (let i = 0; i < 25; i += 1) {
    const frame = await request(
      `/frame/attacker-${i}?lat=${40 + i / 100}&lon=-74&heading=${i}`,
    );
    assert.equal(frame.status, 200);
    assert.equal(frame.headers['X-CCTV-Source'], 'synthetic');
  }
  assert.equal(calls.length, 0);
});

test('Street View fallback refuses cross-site callers such as a foreign <img>', async (t) => {
  const { request, calls } = await streetViewHarness(t);
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { 'x-forwarded-for': '203.0.113.7' },
  ]) {
    const frame = await request('/frame/eiffel', headers);
    assert.equal(frame.headers['X-CCTV-Source'], 'synthetic', headers);
  }
  assert.equal(calls.length, 0);
  const own = await request('/frame/eiffel', {
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(own.headers['X-CCTV-Source'], 'streetview');
  assert.equal(calls.length, 1);
});

test('Street View fallback pins the location to the registered camera', async (t) => {
  const { request, calls } = await streetViewHarness(t);
  // A calibration nudge (~200 m) is honoured...
  await request('/frame/eiffel?lat=48.8602&lon=2.2945&heading=90');
  assert.equal(calls.at(-1).searchParams.get('location'), '48.8602,2.2945');
  assert.equal(calls.at(-1).searchParams.get('key'), 'server-key-fixture');
  // ...but a far-away or invalid pose snaps back to the registered position.
  for (const query of [
    'lat=40.7128&lon=-74.006',
    'lat=95&lon=2.2945',
    'lat=abc&lon=def',
  ]) {
    await request(`/frame/eiffel?${query}&heading=91`);
    assert.equal(
      calls.at(-1).searchParams.get('location'),
      '48.8584,2.2945',
      query,
    );
  }
  assert.deepEqual(
    resolveStreetViewPose(undefined, new URLSearchParams('lat=1&lon=1')),
    null,
  );
});

test('Street View fallback is throttled per IP and repeats are served from cache', async (t) => {
  assert.equal(STREETVIEW_DEFAULT_PER_MIN, 120);
  const { request, calls } = await streetViewHarness(t, {
    GEV_RATELIMIT_GOOGLE_PER_MIN: '3',
  });
  // The same pose polled every refresh costs one call.
  for (let i = 0; i < 10; i += 1) await request('/frame/eiffel');
  assert.equal(calls.length, 1);
  const sources = [];
  for (let heading = 1; heading <= 6; heading += 1) {
    const frame = await request(`/frame/eiffel?heading=${heading}`);
    sources.push(frame.headers['X-CCTV-Source']);
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(sources, [
    'streetview',
    'streetview',
    'synthetic',
    'synthetic',
    'synthetic',
    'synthetic',
  ]);
});
