'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

// The plugin side of server/kp-proxy.js: when the user sets their own server
// address, every request goes there, with no key and no local quota counting.

const PROXY = 'https://kp.example.com';

function providerOfUrl(url) {
  return url.indexOf('/kpu/') >= 0 ? 'kpu' : (url.indexOf('/kpdev/') >= 0 ? 'kpdev' : 'direct');
}

function searchVia(plugin) {
  return new Promise((resolve) => plugin._get('search', 'завод|1', 60,
    (p) => ({ path: p.searchPath('завод', 1), parse: p.parseSearch }),
    (d) => resolve({ ok: d }), (e) => resolve({ err: e })));
}

test('without a server address the plugin talks to the APIs directly, as before', async () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);
  await searchVia(plugin);

  assert.ok(mock.calls.requests[0].url.indexOf('https://api.poiskkino.dev/') === 0);
  assert.ok(mock.calls.requests[0].params.headers['X-API-KEY']);
});

test('with a server address every request goes to <server>/<provider>/<same path>', async () => {
  const mock = makeMock({ storage: { kp_proxy: PROXY } });
  const plugin = loadPlugin(mock);
  await searchVia(plugin);

  const url = mock.calls.requests[0].url;
  assert.ok(url.indexOf(PROXY + '/kpdev/v1.4/movie/search?query=') === 0, url);
});

test('no key leaves the device in proxy mode — the server holds them', async () => {
  const mock = makeMock({ storage: { kp_proxy: PROXY, kp_token: 'MY-KEY' } });
  const plugin = loadPlugin(mock);
  await searchVia(plugin);

  const headers = mock.calls.requests[0].params.headers || {};
  assert.strictEqual(headers['X-API-KEY'], undefined, 'the key must not be sent to the proxy');
});

test('in proxy mode the second provider works without a local token', () => {
  const mock = makeMock({ storage: { kp_proxy: PROXY } }); // no kp_token_unofficial
  const plugin = loadPlugin(mock);
  assert.deepStrictEqual(plugin._availableProviders().map((p) => p.name), ['kpdev', 'kpu']);
});

test('in proxy mode requests are not counted against a local daily limit', async () => {
  // Most of them are hits in the server's shared cache; counting them here
  // would hit a limit that does not exist.
  const mock = makeMock({ storage: { kp_proxy: PROXY, kp_limit_kpdev: 1 } });
  const plugin = loadPlugin(mock);

  await searchVia(plugin);
  const second = await new Promise((resolve) => plugin._get('search', 'другое|1', 60,
    (p) => ({ path: p.searchPath('другое', 1), parse: p.parseSearch }),
    (d) => resolve({ ok: d }), (e) => resolve({ err: e })));

  assert.ok(second.ok, 'a local limit of 1 must not stop the second request');
  assert.strictEqual(plugin._quotaUsed(plugin._KPDEV), 0);
});

test('a 403 from the server still fails over to the other provider through the server', async () => {
  const mock = makeMock({
    storage: { kp_proxy: PROXY },
    responder: (url) => (providerOfUrl(url) === 'kpdev'
      ? { __error: 403 }
      : { films: [{ filmId: 7, nameRu: 'Найдено', type: 'FILM', year: '2020' }] })
  });
  const plugin = loadPlugin(mock);
  const res = await searchVia(plugin);

  assert.ok(res.ok);
  assert.strictEqual(res.ok.results[0].title, 'Найдено');
  assert.deepStrictEqual(mock.calls.requests.map((r) => providerOfUrl(r.url)), ['kpdev', 'kpu']);
  assert.ok(mock.calls.requests.every((r) => r.url.indexOf(PROXY) === 0), 'both attempts go through the server');
});

test('the server address is normalised: trailing slashes, missing scheme, Lampa\'s "undefined"', () => {
  const cases = [
    ['https://kp.example.com/', 'https://kp.example.com'],
    ['https://kp.example.com///', 'https://kp.example.com'],
    ['kp.example.com:8787', 'http://kp.example.com:8787'],
    ['  https://kp.example.com  ', 'https://kp.example.com'],
    ['undefined', ''],
    ['', '']
  ];
  cases.forEach(([input, expected]) => {
    const plugin = loadPlugin(makeMock({ storage: { kp_proxy: input } }));
    assert.strictEqual(plugin._proxyBase(), expected, JSON.stringify(input));
  });
});

test('with no budget on the server the user is told to add a key there, not in Lampa', async () => {
  const mock = makeMock({ storage: { kp_proxy: PROXY } });
  const plugin = loadPlugin(mock);
  plugin._quotaExhaust(plugin._KPDEV);
  plugin._quotaExhaust(plugin._KPU);

  await searchVia(plugin);

  const noty = mock.calls.noty.join(' ');
  assert.ok(/сервер/.test(noty), 'expected a server-side hint, got: ' + noty);
  assert.strictEqual(mock.calls.requests.length, 0);
});

test('the settings screen has a field for the server address, and changing it clears the cache', () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);
  plugin._start();

  const param = mock.calls.settingsParams.find((p) => p.param.name === 'kp_proxy');
  assert.ok(param, 'kp_proxy field is missing');

  mock.store[plugin._CACHE_KEY] = { 'search|x': { until: Date.now() + 1e6, at: Date.now(), data: 1 } };
  param.onChange();
  assert.deepStrictEqual(mock.store[plugin._CACHE_KEY], {}, 'answers from the old origin must not linger');
});
