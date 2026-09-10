'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, makeDualMock, loadPlugin } = require('./helpers/lampa-mock');

function searchOf(mock, params) {
  const { KP } = loadPlugin(mock);
  return new Promise((done) => KP.search(params, done, () => done([])));
}

test('search splits the answer into a movie row and a series row', async () => {
  const rows = await searchOf(makeMock(), { query: 'джентльмены' });

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].title, 'Фильмы');
  assert.strictEqual(rows[0].type, 'movie');
  assert.strictEqual(rows[1].title, 'Сериалы');
  assert.strictEqual(rows[1].type, 'tv');
  assert.ok(rows[0].results.every((c) => c.title && !c.original_name));
  assert.ok(rows[1].results.every((c) => c.original_name));
});

test('the unofficial provider splits movies and series the same way', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0 ? { __error: 403 } : undefined)
  });
  // fall through to the mock's default unofficial fixtures
  const rows = await searchOf(makeDualMock({
    responder: (url) => {
      if (url.indexOf('poiskkino') >= 0) return { __error: 403 };
      return { pagesCount: 1, films: [
        { filmId: 1, nameRu: 'Кино', type: 'FILM', year: '2020' },
        { filmId: 2, nameRu: 'Сериал', nameOriginal: 'Series', type: 'TV_SERIES', year: '2021' }
      ] };
    }
  }), { query: 'x' });

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].results[0].title, 'Кино');
  assert.strictEqual(rows[1].results[0].name, 'Сериал');
});

test('a row is omitted entirely when nothing of that kind was found', async () => {
  const mock = makeMock({ responder: () => ({ docs: [{ id: 1, name: 'Фильм', type: 'movie', rating: {}, votes: {} }], pages: 1 }) });
  const rows = await searchOf(mock, { query: 'что-то' });

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'Фильмы');
});

test('the query is percent-encoded on the way out for both providers', async () => {
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0 ? { __error: 403 } : { films: [] })
  });
  await searchOf(mock, { query: 'завод' });

  mock.calls.requests.forEach((r) => {
    assert.ok(/%D0%B7/.test(r.url), 'cyrillic must be encoded in ' + r.provider + ': ' + r.url);
  });
});

test('a query that arrives already encoded is not double-encoded', async () => {
  const mock = makeMock();
  await searchOf(mock, { query: encodeURIComponent('завод') });

  const url = mock.calls.requests[0].url;
  assert.ok(/query=%D0%B7/.test(url));
  assert.ok(url.indexOf('%25') < 0, 'double encoding leaked in: ' + url);
});

test('a bare percent sign in the query does not throw', async () => {
  const rows = await searchOf(makeMock(), { query: '100% любви' });
  assert.ok(Array.isArray(rows));
});

test('an empty query answers with no rows and spends nothing', async () => {
  const mock = makeMock();
  const rows = await searchOf(mock, { query: '   ' });

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

test('"more" from the search tab opens a Kinopoisk grid', () => {
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

test('the "more" grid pages through the same search', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const page = await new Promise((done) => KP.list({ query: encodeURIComponent('завод'), page: 2 }, done, done));

  assert.strictEqual(page.source, 'kp');
  assert.strictEqual(page.total_pages, 3);
  assert.ok(page.results.length);
  assert.ok(mock.calls.requests[0].url.indexOf('page=2') >= 0, 'the requested page must reach the API');
});

test('the grid asks for nothing when there is no query', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const page = await new Promise((done) => KP.list({}, done, done));

  assert.deepStrictEqual(page.results, []);
  assert.strictEqual(mock.calls.requests.length, 0);
});

test('a failed search reports failure rather than pretending nothing was found', async () => {
  // The tab showing "0" for an exhausted quota is exactly what sent the user
  // looking for a bad token.
  const mock = makeMock({ responder: () => ({ __error: 403 }) });
  const { KP } = loadPlugin(mock);

  const failed = await new Promise((resolve) => KP.search({ query: 'завод' }, () => resolve(false), () => resolve(true)));
  assert.strictEqual(failed, true);
});
