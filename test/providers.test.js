'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, makeDualMock, loadPlugin } = require('./helpers/lampa-mock');

const DEFAULT_TOKEN = 'WC22CBY-RFA4RS0-Q79XE2S-04DR4DH';

function build(provider) {
  return { path: 'v1.4/movie/search?query=x', parse: (json) => json };
}
// The unofficial provider needs its own path, so build from the provider itself
// wherever the test cares which endpoint was hit.
function buildSearch(provider) {
  return { path: provider.searchPath('завод', 1), parse: provider.parseSearch };
}

function get(plugin, kind, key, build) {
  return new Promise((resolve) => plugin._get(kind, key, 60, build, (d) => resolve({ ok: d }), (e) => resolve({ err: e })));
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('kinopoisk.dev falls back to the built-in token, the unofficial one has none', () => {
  const { _KPDEV, _KPU, _tokenOf } = loadPlugin(makeMock());
  assert.strictEqual(_tokenOf(_KPDEV), DEFAULT_TOKEN);
  assert.strictEqual(_tokenOf(_KPU), '', 'without a key the second provider must stay unused');
});

test("Lampa's 'undefined' string is not mistaken for a token", () => {
  const { _KPU, _tokenOf } = loadPlugin(makeMock({ storage: { kp_token_unofficial: 'undefined' } }));
  assert.strictEqual(_tokenOf(_KPU), '');
});

test('a provider without a token is never attempted', async () => {
  const mock = makeMock(); // no unofficial key
  const plugin = loadPlugin(mock);

  assert.deepStrictEqual(plugin._availableProviders().map((p) => p.name), ['kpdev']);

  await get(plugin, 'search', 'a', buildSearch);
  assert.ok(mock.calls.requests.every((r) => r.provider === 'kpdev'));
});

test('with both keys present both providers are available, kinopoisk.dev first', () => {
  const plugin = loadPlugin(makeDualMock());
  assert.deepStrictEqual(plugin._availableProviders().map((p) => p.name), ['kpdev', 'kpu']);
});

test('each provider sends its own token in X-API-KEY', async () => {
  const mock = makeDualMock({ storage: { kp_token: 'DEV-KEY' } });
  const plugin = loadPlugin(mock);

  // force a failover so both are hit
  await get(plugin, 'search', 'a', buildSearch);
  assert.strictEqual(mock.calls.requests[0].params.headers['X-API-KEY'], 'DEV-KEY');

  plugin._quotaExhaust(plugin._KPDEV);
  await get(plugin, 'search', 'b', buildSearch);
  const kpu = mock.calls.requests.find((r) => r.provider === 'kpu');
  assert.ok(kpu, 'the second provider must have been used');
  assert.strictEqual(kpu.params.headers['X-API-KEY'], 'KPU-KEY');
});

// ---------------------------------------------------------------------------
// Failover — the reason two providers exist
// ---------------------------------------------------------------------------

test('a 403 on the first provider silently falls through to the second', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0
      ? { __error: 403 }
      : { films: [{ filmId: 7, nameRu: 'Найдено', type: 'FILM', year: '2020' }] })
  });
  const plugin = loadPlugin(mock);

  const res = await get(plugin, 'search', 'завод', buildSearch);

  assert.ok(res.ok, 'the search must succeed via the fallback');
  assert.strictEqual(res.ok.results[0].title, 'Найдено');
  assert.deepStrictEqual(mock.calls.requests.map((r) => r.provider), ['kpdev', 'kpu']);
});

test('a 401 on the first provider also falls through, and says which token is wrong', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0
      ? { __error: 401 }
      : { films: [{ filmId: 7, nameRu: 'Найдено', type: 'FILM' }] })
  });
  const plugin = loadPlugin(mock);

  const res = await get(plugin, 'search', 'завод', buildSearch);

  assert.ok(res.ok);
  const noty = mock.calls.noty.join(' ');
  assert.ok(/kinopoisk\.dev/.test(noty), 'the warning must name the provider: ' + noty);
  assert.ok(/некорректен/.test(noty));
});

test('after a 403 the exhausted provider is skipped entirely on later requests', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0 ? { __error: 403 } : { films: [] })
  });
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'a', buildSearch);
  assert.strictEqual(plugin._quotaLeft(plugin._KPDEV), 0, 'the server is the authority, not our counter');

  mock.calls.requests.length = 0;
  await get(plugin, 'search', 'b', buildSearch);

  assert.ok(mock.calls.requests.every((r) => r.provider === 'kpu'),
    'a provider known to be out of budget must not be retried');
});

test('when every provider fails and nothing is cached, the caller gets an error, not empty results', async () => {
  const mock = makeDualMock({ responder: () => ({ __error: 403 }) });
  const plugin = loadPlugin(mock);

  const res = await get(plugin, 'search', 'завод', buildSearch);

  assert.ok(res.err, 'a failure must not look like "nothing found"');
  assert.deepStrictEqual(mock.calls.requests.map((r) => r.provider), ['kpdev', 'kpu']);
});

test('when every provider fails but something is cached, the stale copy is served', async () => {
  let down = false;
  const mock = makeDualMock({
    responder: (url) => (down ? { __error: 403 } : { docs: [{ id: 1, name: 'кино' }], pages: 1, page: 1 })
  });
  const plugin = loadPlugin(mock);

  await new Promise((r) => plugin._get('search', 'k', 0, buildSearch, r, r));
  down = true;
  const res = await new Promise((r) => plugin._get('search', 'k', 0, buildSearch, (d) => r({ ok: d }), (e) => r({ err: e })));

  assert.ok(res.ok, 'yesterday beats an empty screen');
  assert.strictEqual(res.ok.results[0].title, 'кино');
});

// ---------------------------------------------------------------------------
// Quota accounting
// ---------------------------------------------------------------------------

test('quota is counted per provider, not globally', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0 ? { __error: 403 } : { films: [] })
  });
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'a', buildSearch);

  assert.strictEqual(plugin._quotaUsed(plugin._KPU), 1);
  assert.strictEqual(plugin._quotaLeft(plugin._KPU), 499, 'the unofficial provider allows 500/day');
});

test('the two providers have the documented free budgets', () => {
  const { _KPDEV, _KPU, _limitOf } = loadPlugin(makeMock());
  assert.strictEqual(_limitOf(_KPDEV), 200);
  assert.strictEqual(_limitOf(_KPU), 500);
});

test('a cache hit costs neither a request nor quota', async () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'завод', buildSearch);
  assert.strictEqual(mock.calls.requests.length, 1);
  const spent = plugin._quotaUsed(plugin._KPDEV);

  const again = await get(plugin, 'search', 'завод', buildSearch);
  assert.ok(again.ok);
  assert.strictEqual(mock.calls.requests.length, 1, 'the second identical request must not hit the network');
  assert.strictEqual(plugin._quotaUsed(plugin._KPDEV), spent);
});

test('one cache entry is shared by both providers — the same title, whoever found it', async () => {
  // A result fetched from kinopoisk.dev must satisfy a later request even when
  // the first provider is out of budget, without touching the second.
  const mock = makeDualMock();
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'завод', buildSearch);
  plugin._quotaExhaust(plugin._KPDEV);
  mock.calls.requests.length = 0;

  const cached = await get(plugin, 'search', 'завод', buildSearch);

  assert.ok(cached.ok);
  assert.strictEqual(mock.calls.requests.length, 0, 'the cache is keyed by the title, not by the provider');
});

test('with no budget anywhere the user is told how to get more', async () => {
  const mock = makeMock({ storage: { kp_limit_kpdev: 1 } }); // no unofficial token
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'a', buildSearch);   // spends the only allowed request
  const res = await get(plugin, 'search', 'b', buildSearch);

  assert.ok(res.err);
  assert.strictEqual(mock.calls.requests.length, 1, 'no request may be made past the budget');
  const noty = mock.calls.noty.join(' ');
  assert.ok(/500/.test(noty), 'expected the hint about the second provider, got: ' + noty);
});

test('an unparsable response fails that provider instead of caching garbage', async () => {
  const mock = makeMock({ responder: () => ({ docs: null }) });
  const plugin = loadPlugin(mock);

  const res = await new Promise((r) => plugin._get('search', 'x', 60,
    () => ({ path: 'p', parse: () => { throw new Error('bad'); } }),
    (d) => r({ ok: d }), (e) => r({ err: e })));

  assert.ok(res.err);
  assert.strictEqual(res.err.parse, true);
});

test('the cache is also handed to Lampa, so its own layer can serve a stale copy', async () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);

  await get(plugin, 'search', 'a', buildSearch);

  assert.ok(mock.calls.requests[0].params.cache.life > 0);
});
