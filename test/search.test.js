'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

function searchOf(mock, params) {
  const { KP } = loadPlugin(mock);
  return new Promise((done) => KP.search(params, done, () => done([])));
}

test('search splits the Kinopoisk answer into a movie row and a series row', async () => {
  const rows = await searchOf(makeMock(), { query: 'джентльмены' });

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].title, 'Фильмы');
  assert.strictEqual(rows[0].type, 'movie');
  assert.strictEqual(rows[1].title, 'Сериалы');
  assert.strictEqual(rows[1].type, 'tv');
  assert.ok(rows[0].results.every((c) => c.title && !c.original_name));
  assert.ok(rows[1].results.every((c) => c.original_name));
});

test('a row is omitted entirely when nothing of that kind was found', async () => {
  const mock = makeMock({ responder: () => ({ docs: [{ id: 1, name: 'Фильм', type: 'movie', rating: {}, votes: {} }] }) });
  const rows = await searchOf(mock, { query: 'что-то' });

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'Фильмы');
});

test('the query is percent-encoded on the way out — Cyrillic in a raw url breaks the request', async () => {
  const mock = makeMock();
  await searchOf(mock, { query: 'джентльмены' });

  const url = mock.calls.requests[0].url;
  assert.ok(url.indexOf('query=%D0%B4') >= 0, 'expected an encoded query, got: ' + url);
});

test('a query that arrives already encoded is not double-encoded', async () => {
  const mock = makeMock();
  await searchOf(mock, { query: encodeURIComponent('джентльмены') });

  const url = mock.calls.requests[0].url;
  assert.ok(url.indexOf('query=%D0%B4') >= 0);
  assert.ok(url.indexOf('%25') < 0, 'double encoding leaked in: ' + url);
});

test('a bare percent sign in the query does not throw', async () => {
  const mock = makeMock();
  const rows = await searchOf(mock, { query: '100% любви' });
  assert.ok(Array.isArray(rows));
});

test('an empty query answers with no rows and spends nothing', async () => {
  const mock = makeMock();
  const rows = await searchOf(mock, { query: '' });

  assert.deepStrictEqual(rows, []);
  assert.strictEqual(mock.calls.requests.length, 0);
});

test('discovery() puts a Kinopoisk tab into the global search', () => {
  const { KP } = loadPlugin(makeMock());
  const d = KP.discovery();

  assert.strictEqual(d.title, 'Кинопоиск');
  assert.strictEqual(d.search, KP.search);
  assert.strictEqual(typeof d.onMore, 'function');
  assert.strictEqual(typeof d.onCancel, 'function');
});

test('"more" from the search tab opens a Kinopoisk grid, not a TMDB one', () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);
  let closed = false;

  KP.discovery().onMore({ query: 'матрица' }, () => { closed = true; });

  assert.strictEqual(closed, true, 'the search overlay must close first');
  const push = mock.calls.activityPush[0];
  assert.strictEqual(push.component, 'category_full');
  assert.strictEqual(push.source, 'kp');
  assert.strictEqual(decodeURIComponent(push.query), 'матрица');
});

test('the actor page maps a Kinopoisk person into the structure Lampa expects', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const data = await new Promise((done) => KP.person({ id: 797 }, done, () => done(null)));

  assert.ok(data.person, 'data.person renders the header');
  assert.strictEqual(data.person.name, 'Мэттью Макконахи');
  assert.strictEqual(data.person.birthday, '1969-11-04');
  assert.strictEqual(data.person.img, 'https://kp/p/797');

  assert.ok(data.credits, 'data.credits renders the filmography');
  assert.strictEqual(data.credits.cast.length, 1);
  assert.strictEqual(data.credits.cast[0].title, 'Джентльмены');
  assert.strictEqual(data.credits.cast[0].source, 'kp');
  assert.ok(data.credits.knownFor.length);
});

test('menuCategory offers Kinopoisk queries for the Movies and Series menu items', async () => {
  const { KP } = loadPlugin(makeMock());

  const movies = await new Promise((done) => KP.menuCategory({ action: 'movie' }, done));
  const series = await new Promise((done) => KP.menuCategory({ action: 'tv' }, done));

  assert.ok(movies.every((m) => m.url.indexOf('type=movie') === 0 && m.source === 'kp'));
  assert.ok(series.every((m) => m.url.indexOf('type=tv-series') === 0 && m.source === 'kp'));
});
