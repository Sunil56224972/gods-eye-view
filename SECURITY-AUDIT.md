# Security Audit — God's Eye View

I went through the server-side proxy code manually and found a few things worth fixing. Nothing earth-shattering on its own, but the DNS rebinding one (#1) chains with the others to create a real problem.

## What I found

### 1. DNS rebinding lets anyone steal your API keys when HOST=0.0.0.0

This is the big one. In `build/vite.js`, when you set `HOST=0.0.0.0` (which the docs recommend for LAN sharing), `allowedHosts` gets set to `true`:

```js
allowedHosts: host === '0.0.0.0' || host === '::' ? true : [...]
```

That completely disables Vite's hostname check. So if you're running the dev server on your LAN and you visit a sketchy website, that site can do DNS rebinding — point its domain at 127.0.0.1 — and then hit your local server freely. From there it can:

- Call `/api/realtime/token` and get a working OpenAI session token (minted from your secret key)
- Hit `/api/setup/status` to see which keys you have configured
- POST to `/api/setup/keys` to mess with your `.env`
- Spam `/api/openai/hud-summary` and burn through your OpenAI credits

I put a demo page in `security/poc/01-dns-rebinding-exploit.html` that shows this.

**Fix:** Changed to a fixed allowlist `['localhost', '127.0.0.1', '::1', '.local']` regardless of the HOST setting.

---

### 2. Debug log lets you fake timestamps

In `server/providers/openai/debug-log.js`, the handler does this:

```js
{ loggedAt: new Date().toISOString(), ...record }
```

Problem is the spread comes *after* `loggedAt`. So if someone sends `{"loggedAt": "2020-01-01T00:00:00Z"}` in the POST body, their value overwrites the server timestamp. You can backdate log entries, which ruins any forensic value the log has.

Quick test:
```bash
curl -X POST http://localhost:4173/api/realtime/log \
  -H 'Content-Type: application/json' \
  -d '{"loggedAt":"2020-01-01T00:00:00.000Z","type":"session.created"}'
```

Check `.gev-logs/realtime-conversations.jsonl` — you'll see the 2020 date.

**Fix:** Flipped the order so `loggedAt` comes after the spread (can't be overridden), and added a `delete record.loggedAt` for good measure.

---

### 3. No rate limit on the credential setup endpoint

Every other sensitive endpoint has a rate limiter — military installations gets 90/min, route gets 60/min, the debug log gets 120/min. But `/api/setup/status` and `/api/setup/keys`? Nothing. Zero throttling on the endpoint that reads and writes your API keys.

On its own the loopback check stops remote attackers, but chain it with the DNS rebinding from #1 and you've got unlimited automated access to the credential store.

**Fix:** Added a `makeRateLimiter` call — 10 req/min per IP, 30 global. Tight limit since legitimate use is just manual key entry.

---

### 4. No `X-Content-Type-Options: nosniff` on any API response

The key-setup endpoint sets `X-Frame-Options` and CSP, but every other API endpoint returns JSON with zero defensive headers. Without `nosniff`, older browsers can MIME-sniff a JSON response as HTML and run whatever's in it.

Not the end of the world on its own, but it's a one-line fix in the Vite config.

**Fix:** Added `'X-Content-Type-Options': 'nosniff'` to the server's global headers.

---

### 5. OpenAI rate limiting is off by default

`makeOptInRateLimiter()` returns null (unlimited) when `GEV_RATELIMIT_OPENAI_PER_MIN` is unset. The env example even says "DEFAULT IS UNLIMITED". Combined with DNS rebinding, a malicious page can just loop HUD summary calls and burn your OpenAI balance. Each call uses tokens — at 100 req/sec that adds up fast.

**Fix:** Changed the default from unlimited to 30 req/min. If someone explicitly sets `GEV_RATELIMIT_OPENAI_PER_MIN=0` they can still opt out.

---

### 6. OpenAI token minting has no access control — LAN callers can drain your billing

This is the counterpart to #1 that still works even after the DNS rebinding fix.

The `/api/realtime/token` endpoint takes the server's secret `OPENAI_API_KEY`, sends it to OpenAI, and hands back a working ephemeral session token. The `/api/openai/hud-summary` endpoint does the same — each call costs tokens.

The key-setup endpoints that *manage* credentials have 9 layers of defense: loopback socket check, local hostname check, proxy header rejection, sharing mode check, origin validation, content-type enforcement, rate limiting, externally-managed guard, and symlink protection. That's Fort Knox.

But the endpoints that actually *spend* the key? Zero access control. Just an opt-in rate limiter (30/min default).

With `HOST=0.0.0.0` (which the docs recommend for LAN sharing), any device on the network can:

```bash
# from any machine on the LAN
curl http://192.168.1.100:4173/api/realtime/token
# → 200 OK + working OpenAI session token

curl -X POST http://192.168.1.100:4173/api/openai/hud-summary \
  -H 'Content-Type: application/json' \
  -d '{"place":"test","layers":[]}'
# → 200 OK (each call costs tokens)
```

At the default 30 req/min rate limit, that's 43,200 token-minting requests per day. Each one creates a session that can make OpenAI API calls on the owner's account.

The asymmetry is the bug: the door to the vault has 9 locks, but the ATM in the lobby has none.

**Fix:** Added a loopback-only check (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) to both `realtime.js` and `hud-summary.js`. Non-loopback callers get 403 before the API key is even read. Same pattern the key-setup endpoints already use, just applied to the endpoints that actually cost money.

---

## Changed files

- `build/vite.js` — DNS rebinding fix + nosniff header
- `server/providers/openai/debug-log.js` — timestamp forgery fix
- `server/standalone/key-setup.js` — added rate limiting
- `server/providers/common/rate-limit.js` — secure default for OpenAI throttle
- `server/providers/openai/realtime.js` — loopback-only access control on token minting
- `server/providers/openai/hud-summary.js` — loopback-only access control on HUD summary

## POC scripts

All in `security/poc/`:
- `01-dns-rebinding-exploit.html` — open in browser while dev server is running
- `02-log-forgery.mjs` — run with `node security/poc/02-log-forgery.mjs`
- `03-keyset-no-ratelimit.mjs` — floods the credential endpoint
- `04-missing-nosniff.mjs` — scans endpoints for missing headers
- `05-openai-cost-drain.mjs` — demonstrates unlimited OpenAI calls
- `06-token-no-access-control.mjs` — proves LAN callers can mint tokens
