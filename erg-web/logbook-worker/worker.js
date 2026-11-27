// Concept2 Logbook sync server for Erg Trainer, as a Cloudflare Worker.
//
// It does the three things a public web page can't do safely:
//   GET  /login      -> sends you to Concept2 to approve access
//   GET  /callback   -> swaps Concept2's code for tokens (needs the client secret), then returns
//                       you to the app with the tokens in the URL fragment
//   POST /refresh    -> renews an expired access token
// and relays three Logbook API calls (GET users/me, GET and POST users/me/results) for the app.
//
// Settings (wrangler.toml [vars] and `wrangler secret put`):
//   C2_CLIENT_ID      from your Concept2 developer account
//   C2_CLIENT_SECRET  secret, from your Concept2 developer account
//   STATE_SECRET      secret, any long random string
//   C2_BASE_URL       https://log-dev.concept2.com while testing, https://log.concept2.com once approved
//   APP_URL           where the app lives, e.g. https://you.github.io/peloton-to-garmin/erg-web/

const SCOPE = 'user:read,results:read,results:write';
const STATE_TTL_MS = 10 * 60 * 1000;
const ALLOWED_API = [
  { method: 'GET', path: 'users/me' },
  { method: 'GET', path: 'users/me/results' }, // history, for suggested targets
  { method: 'POST', path: 'users/me/results' },
];
// Query parameters passed through on GET users/me/results (filters and paging).
const ALLOWED_QUERY = ['from', 'to', 'type', 'number', 'page', 'updated_after'];

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text) => b64url(enc.encode(text));

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}

// Signed, time-limited state so the callback only accepts sign-ins this server started.
export async function makeState(secret, now = Date.now()) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${nonce}.${now}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function checkState(secret, state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!(now - Number(ts) >= 0 && now - Number(ts) < STATE_TTL_MS)) return false;
  return sig === (await hmac(secret, `${nonce}.${ts}`));
}

function cors(env, response) {
  const origin = new URL(env.APP_URL).origin;
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Vary', 'Origin');
  return response;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function backToApp(env, fragment) {
  return Response.redirect(`${env.APP_URL}#${fragment}`, 302);
}

async function tokenRequest(env, params) {
  const body = new URLSearchParams({ client_id: env.C2_CLIENT_ID, client_secret: env.C2_CLIENT_SECRET, scope: SCOPE, ...params });
  const res = await fetch(`${env.C2_BASE_URL}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.access_token, status: res.status, data };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const callbackUrl = `${url.origin}/callback`;

    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));

    if (url.pathname === '/login' && request.method === 'GET') {
      const auth = new URL(`${env.C2_BASE_URL}/oauth/authorize`);
      auth.search = new URLSearchParams({
        client_id: env.C2_CLIENT_ID,
        scope: SCOPE,
        response_type: 'code',
        redirect_uri: callbackUrl,
        state: await makeState(env.STATE_SECRET),
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    if (url.pathname === '/callback' && request.method === 'GET') {
      const err = url.searchParams.get('error');
      if (err) return backToApp(env, `c2error=${encodeURIComponent(err === 'access_denied' ? 'Access was not approved.' : err)}`);
      if (!(await checkState(env.STATE_SECRET, url.searchParams.get('state')))) {
        return backToApp(env, `c2error=${encodeURIComponent('Sign-in expired or was not started from the app. Try again.')}`);
      }
      const t = await tokenRequest(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: callbackUrl });
      if (!t.ok) return backToApp(env, `c2error=${encodeURIComponent(`Concept2 sign-in failed (${t.status}).`)}`);
      const { access_token, refresh_token, expires_in } = t.data;
      return backToApp(env, `c2=${b64urlText(JSON.stringify({ access_token, refresh_token, expires_in }))}`);
    }

    if (url.pathname === '/refresh' && request.method === 'POST') {
      const { refresh_token } = await request.json().catch(() => ({}));
      if (!refresh_token) return cors(env, json({ message: 'refresh_token required' }, 400));
      const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token });
      if (!t.ok) return cors(env, json({ message: 'Refresh failed' }, t.status === 500 ? 502 : 401));
      const { access_token, refresh_token: next, expires_in } = t.data;
      return cors(env, json({ access_token, refresh_token: next, expires_in }));
    }

    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(5);
      if (!ALLOWED_API.some((a) => a.method === request.method && a.path === path)) return cors(env, json({ message: 'Not allowed' }, 404));
      const auth = request.headers.get('Authorization');
      if (!auth?.startsWith('Bearer ')) return cors(env, json({ message: 'Missing token' }, 401));
      const query = new URLSearchParams();
      if (request.method === 'GET') {
        for (const k of ALLOWED_QUERY) if (url.searchParams.has(k)) query.set(k, url.searchParams.get(k));
      }
      const qs = query.toString();
      const res = await fetch(`${env.C2_BASE_URL}/api/${path}${qs ? `?${qs}` : ''}`, {
        method: request.method,
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/vnd.c2logbook.v1+json', 'X-Client-Version': 'erg-trainer-1' },
        body: request.method === 'POST' ? await request.text() : undefined,
      });
      return cors(env, new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } }));
    }

    if (url.pathname === '/') return new Response('Erg Trainer Logbook sync server is running.', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
};
