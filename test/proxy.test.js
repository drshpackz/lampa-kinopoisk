'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, ttlFor } = require('../server/kp-proxy');

// A fake upstream: `routes(url, token)` returns {status, body}. Records calls.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const token = init && init.headers && init.headers['X-API-KEY'];
    calls.push({ url, token });
    const r = routes(url, token);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kp-proxy-test-')); }

async function start(opts) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, method) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  return { server, get, close: () => new Promise((r) => server.close(r)) };
}

const OK = { status: 200, body: { docs: [{ id: 1, name: 'Завод' }] } };
const FILM = '/kpdev/v1.4/movie/993591';

test('a whitelisted request is forwarded with the SERVER\'s token and passed through', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['SERVER-KEY'] }, fetch });
  try {
    const r = await s.get(FILM);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), OK.body);
    assert.strictEqual(fetch.calls[0].url, 'https://api.poiskkino.dev/v1.4/movie/993591');
    assert.strictEqual(fetch.calls[0].token, 'SERVER-KEY');
    assert.strictEqual(r.headers['access-control-allow-origin'], '*', 'Lampa calls this from a browser');
    assert.strictEqual(r.headers['x-kp-cache'], 'miss');
  } finally { await s.close(); }
});

test('the second identical request is served from cache — zero upstream cost', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['K'] }, fetch });
  try {
    await s.get(FILM);
    const r = await s.get(FILM);
    assert.strictEqual(r.headers['x-kp-cache'], 'hit');
    assert.strictEqual(fetch.calls.length, 1, 'this is the whole point: repeats cost nothing');
  } finally { await s.close(); }
});

test('the cache survives a restart when it lives on disk', async () => {
  const dir = tmpDir();
  const fetch1 = fakeFetch(() => OK);
  const a = await start({ tokens: { kpdev: ['K'] }, fetch: fetch1, cacheDir: dir });
  await a.get(FILM);
  await a.close();

  const fetch2 = fakeFetch(() => { throw new Error('must not be called'); });
  const b = await start({ tokens: { kpdev: ['K'] }, fetch: fetch2, cacheDir: dir });
  try {
    const r = await b.get(FILM);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-kp-cache'], 'hit');
    assert.strictEqual(fetch2.calls.length, 0);
  } finally { await b.close(); }
});

test('INVARIANT: it is not an open proxy — only the plugin\'s own paths pass', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['K'], kpu: ['U'] }, fetch });
  try {
    for (const p of ['/kpdev/v1.5/token', '/kpdev/v1.4/list', '/kpu/api/v1/staff?filmId=1', '/evil/https://example.com', '/kpdev/../etc/passwd']) {
      const r = await s.get(p);
      assert.strictEqual(r.status, 404, p + ' must be refused');
    }
    assert.strictEqual(fetch.calls.length, 0, 'a refused path must never reach an upstream');
  } finally { await s.close(); }
});

test('every path the plugin actually uses is allowed', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['K'], kpu: ['U'] }, fetch });
  try {
    for (const p of [
      '/kpdev/v1.4/movie/search?query=%D0%B7&limit=30&page=1&selectFields=id',
      '/kpdev/v1.4/movie/993591',
      '/kpdev/v1.4/season?movieId=464963&limit=50&page=1&sortField=number&sortType=1',
      '/kpu/api/v2.1/films/search-by-keyword?keyword=%D0%B7&page=1',
      '/kpu/api/v2.2/films/993591',
      '/kpu/api/v2.2/films/464963/seasons'
    ]) {
      const r = await s.get(p);
      assert.strictEqual(r.status, 200, p + ' must be allowed');
    }
  } finally { await s.close(); }
});

test('a CORS preflight is answered', async () => {
  const s = await start({ tokens: { kpdev: ['K'] }, fetch: fakeFetch(() => OK) });
  try {
    const r = await s.get(FILM, 'OPTIONS');
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  } finally { await s.close(); }
});

test('an exhausted key (403) is skipped and the next key is used', async () => {
  const fetch = fakeFetch((url, token) => (token === 'SPENT' ? { status: 403, body: { message: 'лимит' } } : OK));
  const s = await start({ tokens: { kpdev: ['SPENT', 'FRESH'] }, fetch });
  try {
    const r = await s.get(FILM);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(fetch.calls.map((c) => c.token), ['SPENT', 'FRESH']);

    await s.get('/kpdev/v1.4/movie/1');
    assert.deepStrictEqual(fetch.calls.slice(2).map((c) => c.token), ['FRESH'],
      'a key known to be spent today must not be retried on every request');
  } finally { await s.close(); }
});

test('a rejected key (401) is skipped the same way', async () => {
  const fetch = fakeFetch((url, token) => (token === 'BAD' ? { status: 401, body: {} } : OK));
  const s = await start({ tokens: { kpu: ['BAD', 'GOOD'] }, fetch });
  try {
    const r = await s.get('/kpu/api/v2.2/films/1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(s.server.health().tokens.kpu.live, 1);
  } finally { await s.close(); }
});

test('when every key is spent the proxy answers 403, so the plugin fails over to the other provider', async () => {
  const fetch = fakeFetch(() => ({ status: 403, body: { message: 'лимит' } }));
  const s = await start({ tokens: { kpdev: ['A', 'B'] }, fetch });
  try {
    const r = await s.get(FILM);
    assert.strictEqual(r.status, 403, 'the plugin reads 403 as "this provider is out for today"');
  } finally { await s.close(); }
});

test('a provider with no keys answers 403 without touching the network', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['K'] }, fetch });
  try {
    const r = await s.get('/kpu/api/v2.2/films/1');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(fetch.calls.length, 0);
  } finally { await s.close(); }
});

test('an upstream 404 is a fact about the data: passed through, keys untouched', async () => {
  const fetch = fakeFetch(() => ({ status: 404, body: { message: 'нет такого' } }));
  const s = await start({ tokens: { kpdev: ['A', 'B'] }, fetch });
  try {
    const r = await s.get(FILM);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(fetch.calls.length, 1, 'another key would get the same 404');
    assert.strictEqual(s.server.health().tokens.kpdev.live, 2);
  } finally { await s.close(); }
});

test('when the upstream fails, an expired entry is served stale rather than an error', async () => {
  let t = 1000;
  let fail = false;
  const fetch = fakeFetch(() => (fail ? { status: 403, body: {} } : OK));
  const s = await start({ tokens: { kpdev: ['K'] }, fetch, now: () => t });
  try {
    await s.get(FILM);
    t += 31 * 24 * 3600 * 1000; // past the 30-day TTL
    fail = true;
    const r = await s.get(FILM);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-kp-cache'], 'stale');
    assert.deepStrictEqual(JSON.parse(r.body), OK.body);
  } finally { await s.close(); }
});

test('two devices opening the same card at once cost one upstream request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    await gate;
    return { status: 200, text: async () => JSON.stringify(OK.body) };
  };
  const s = await start({ tokens: { kpdev: ['K'] }, fetch });
  try {
    const both = Promise.all([s.get(FILM), s.get(FILM)]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await both;
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(calls.length, 1);
  } finally { await s.close(); }
});

test('health reports counts, never the keys themselves', async () => {
  const s = await start({ tokens: { kpdev: ['SECRET-KEY-1'], kpu: ['SECRET-KEY-2'] }, fetch: fakeFetch(() => OK) });
  try {
    const r = await s.get('/health');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.indexOf('SECRET') < 0, 'a key leaked through /health');
    const h = JSON.parse(r.body);
    assert.strictEqual(h.tokens.kpdev.total, 1);
    assert.strictEqual(h.tokens.kpu.total, 1);
  } finally { await s.close(); }
});

test('search lives a day, cards a month, seasons a week', () => {
  const day = 24 * 3600 * 1000;
  assert.strictEqual(ttlFor('v1.4/movie/search?query=x'), day);
  assert.strictEqual(ttlFor('api/v2.1/films/search-by-keyword?keyword=x'), day);
  assert.strictEqual(ttlFor('v1.4/movie/1'), 30 * day);
  assert.strictEqual(ttlFor('v1.4/season?movieId=1'), 7 * day);
  assert.strictEqual(ttlFor('api/v2.2/films/1/seasons'), 7 * day);
});

test('only GET and OPTIONS are served', async () => {
  const fetch = fakeFetch(() => OK);
  const s = await start({ tokens: { kpdev: ['K'] }, fetch });
  try {
    const r = await s.get(FILM, 'POST');
    assert.strictEqual(r.status, 405);
    assert.strictEqual(fetch.calls.length, 0);
  } finally { await s.close(); }
});
