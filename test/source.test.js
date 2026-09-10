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

test('the source implements every method Lampa calls on a source', () => {
  const { KP } = loadPlugin(makeMock());
  // Mirrors the key set of Lampa's own TMDB source.
  ['main', 'menu', 'menuCategory', 'full', 'list', 'category', 'search', 'discovery',
    'person', 'seasons', 'company', 'favorite', 'clear', 'img'].forEach((name) => {
    assert.strictEqual(typeof KP[name], 'function', 'missing source method: ' + name);
  });
  assert.strictEqual(KP.SOURCE_NAME, 'kp');
});

test('registering does not clobber the built-in tmdb source', () => {
  const mock = makeMock();
  const { _registerSource } = loadPlugin(mock);
  _registerSource();
  assert.ok(mock.Lampa.Api.sources.tmdb, 'tmdb must survive');
  assert.notStrictEqual(mock.Lampa.Api.sources.tmdb, mock.Lampa.Api.sources.kp);
});

test('Kinopoisk is offered in the app-wide source setting alongside TMDB and CUB', () => {
  const mock = makeMock();
  const { _registerSource } = loadPlugin(mock);
  _registerSource();

  const select = mock.calls.paramSelects.find((s) => s.name === 'source');
  assert.ok(select, 'the source select must be re-registered');
  assert.strictEqual(select.values.kp, 'Кинопоиск');
  assert.strictEqual(select.values.tmdb, 'TMDB');
  assert.strictEqual(select.values.cub, 'CUB');
  assert.strictEqual(select.def, 'tmdb', 'TMDB stays the default — we only add an option');
});

test('img() passes an absolute Kinopoisk URL through untouched', () => {
  const { KP } = loadPlugin(makeMock());
  assert.strictEqual(KP.img('https://kp/poster/300x450'), 'https://kp/poster/300x450');
  assert.strictEqual(KP.img(''), '');
  // a bare TMDB-style path still goes through TMDB, so mixed data cannot break
  assert.strictEqual(KP.img('/abc.jpg', 'w200'), 'TMDB:/abc.jpg:w200');
});

test('start() adds the menu item and the settings component', () => {
  const mock = makeMock();
  const { _start } = loadPlugin(mock);
  _start();

  assert.strictEqual(mock.menuList._children.length, 1);
  assert.strictEqual(mock.menuList._children[0].text(), 'Кинопоиск');

  const comp = mock.calls.settingsComponents.find((c) => c.component === 'kinopoisk');
  assert.ok(comp, 'a Kinopoisk settings component must exist');
  const names = mock.calls.settingsParams.map((p) => p.param.name);
  assert.ok(names.indexOf('kp_token') >= 0, 'the token must be editable');
  assert.ok(names.indexOf('kp_quota_limit') >= 0, 'the daily budget must be editable');
});

test('start() is idempotent — a double install does not duplicate the menu item', () => {
  const mock = makeMock();
  const { _start } = loadPlugin(mock);
  _start();
  _start();
  assert.strictEqual(mock.menuList._children.length, 1);
});

test('the menu item opens the main feed on the kp source', () => {
  const mock = makeMock();
  const { _start } = loadPlugin(mock);
  _start();

  mock.menuList._children[0].trigger('hover:enter');

  assert.strictEqual(mock.calls.activityPush.length, 1);
  const push = mock.calls.activityPush[0];
  assert.strictEqual(push.component, 'main');
  assert.strictEqual(push.source, 'kp');
  assert.strictEqual(push.title, 'Кинопоиск');
});

test('on a Lampa without pluggable sources the plugin says so instead of half-installing', () => {
  const mock = makeMock();
  delete mock.Lampa.Api.sources;
  const { _start } = loadPlugin(mock);
  _start();

  assert.strictEqual(mock.menuList._children.length, 0, 'no dead menu item');
  assert.ok(mock.calls.noty.some((m) => m.indexOf('источник') >= 0));
});

test('changing the token clears the cache, so old results are not served under a new key', async () => {
  const mock = makeMock();
  const { _start, _get, _cacheGet } = loadPlugin(mock);
  _start();

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 600, (j) => j, done, done));
  assert.ok(_cacheGet('row|v1.4/movie?a=1'));

  const tokenParam = mock.calls.settingsParams.find((p) => p.param.name === 'kp_token');
  tokenParam.onChange();

  assert.strictEqual(_cacheGet('row|v1.4/movie?a=1'), null);
});
