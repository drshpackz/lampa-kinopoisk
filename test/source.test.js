'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

test('the plugin registers itself as a Lampa API source under "kp"', () => {
  const mock = makeMock();
  const { _registerSource, KP } = loadPlugin(mock);

  assert.strictEqual(_registerSource(), true);
  assert.strictEqual(mock.Lampa.Api.sources.kp, KP);
});

test('the source answers every method Lampa may call on it', () => {
  const { KP } = loadPlugin(makeMock());
  ['search', 'discovery', 'list', 'full', 'seasons',
    'main', 'category', 'menu', 'menuCategory', 'person', 'company', 'favorite',
    'clear', 'img'].forEach((name) => {
    assert.strictEqual(typeof KP[name], 'function', 'missing source method: ' + name);
  });
  assert.strictEqual(KP.SOURCE_NAME, 'kp');
});

test('registering does not clobber the built-in tmdb source', () => {
  const mock = makeMock();
  loadPlugin(mock)._registerSource();
  assert.ok(mock.Lampa.Api.sources.tmdb, 'tmdb must survive');
  assert.notStrictEqual(mock.Lampa.Api.sources.tmdb, mock.Lampa.Api.sources.kp);
});

test('no menu item is added — the plugin lives in search only', () => {
  const mock = makeMock();
  loadPlugin(mock)._start();
  assert.strictEqual(mock.menuList._children.length, 0,
    'a catalog entry would cost ~20 requests per open, which the daily budget cannot pay for');
});

test('a user left on the old catalog source is moved back to TMDB', () => {
  // The previous version offered Кинопоиск as an app-wide source. There is no
  // catalog now, so that choice would render an empty home screen.
  const mock = makeMock({ storage: { source: 'kp' } });
  loadPlugin(mock)._registerSource();
  assert.strictEqual(mock.store.source, 'tmdb');
});

test('a user on TMDB or CUB is left alone', () => {
  ['tmdb', 'cub'].forEach((src) => {
    const mock = makeMock({ storage: { source: src } });
    loadPlugin(mock)._registerSource();
    assert.strictEqual(mock.store.source, src);
  });
});

test('main() refuses rather than hanging if something still asks for a catalog', async () => {
  const { KP } = loadPlugin(makeMock());
  const failed = await new Promise((resolve) => KP.main({}, () => resolve(false), () => resolve(true)));
  assert.strictEqual(failed, true);
});

test('img() passes an absolute Kinopoisk URL through untouched', () => {
  const { KP } = loadPlugin(makeMock());
  assert.strictEqual(KP.img('https://kp/poster/300x450'), 'https://kp/poster/300x450');
  assert.strictEqual(KP.img(''), '');
  // a bare TMDB-style path still goes through TMDB, so mixed data cannot break
  assert.strictEqual(KP.img('/abc.jpg', 'w200'), 'TMDB:/abc.jpg:w200');
});

test('settings expose a token field for each provider', () => {
  const mock = makeMock();
  loadPlugin(mock)._start();

  assert.ok(mock.calls.settingsComponents.some((c) => c.component === 'kinopoisk'));
  const names = mock.calls.settingsParams.map((p) => p.param.name);
  assert.ok(names.indexOf('kp_token') >= 0, 'kinopoisk.dev token must be editable');
  assert.ok(names.indexOf('kp_token_unofficial') >= 0, 'the second provider needs its own field');
});

test('changing either token clears the cache', () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);
  plugin._start();

  ['kp_token', 'kp_token_unofficial'].forEach((name) => {
    mock.store.kp_cache = { 'search|x': { until: Date.now() + 1e6, at: Date.now(), data: 1 } };
    mock.calls.settingsParams.find((p) => p.param.name === name).onChange();
    assert.deepStrictEqual(mock.store.kp_cache, {}, name + ' must invalidate cached answers');
  });
});

test('start() is idempotent — a double install registers the settings once', () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);
  plugin._start();
  plugin._start();
  assert.strictEqual(mock.calls.settingsComponents.length, 1);
});

test('on a Lampa without pluggable sources the plugin says so instead of half-installing', () => {
  const mock = makeMock();
  delete mock.Lampa.Api.sources;
  loadPlugin(mock)._start();

  assert.strictEqual(mock.calls.settingsComponents.length, 0, 'no settings for a plugin that cannot work');
  assert.ok(mock.calls.noty.some((m) => m.indexOf('источник') >= 0));
});
