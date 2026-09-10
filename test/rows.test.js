'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

function load() { return loadPlugin(makeMock()); }

test('INVARIANT: no row uses TMDB discover syntax — this source speaks Kinopoisk', () => {
  const { _allRows } = load();
  _allRows().forEach((row) => {
    assert.ok(row.url.indexOf('discover/') < 0, 'TMDB path leaked into: ' + row.url);
    assert.ok(row.url.indexOf('with_genres') < 0, 'TMDB genre filter leaked into: ' + row.url);
    assert.ok(row.url.indexOf('sort_by=') < 0, 'TMDB sort leaked into: ' + row.url);
    assert.ok(row.url.indexOf('api_key') < 0, 'the key belongs in the header, not the url');
  });
});

test('every row has a title and a non-empty query', () => {
  const { _allRows } = load();
  const rows = _allRows();
  assert.ok(rows.length >= 20, 'expected a real catalog, got ' + rows.length + ' rows');
  rows.forEach((row) => {
    assert.ok(row.title && row.title.length, 'row without a title: ' + JSON.stringify(row));
    assert.ok(row.url && row.url.length, 'row without a query: ' + row.title);
  });
});

test('row titles are unique — two rows with one name are indistinguishable in the feed', () => {
  const { _allRows } = load();
  const seen = {};
  _allRows().forEach((row) => {
    assert.ok(!seen[row.title], 'duplicate row title: ' + row.title);
    seen[row.title] = true;
  });
});

test('Russian genre names are percent-encoded, because they travel in a query string', () => {
  const { _genreRows } = load();
  _genreRows().forEach((row) => {
    const m = /genres\.name=([^&]*)/.exec(row.url);
    assert.ok(m, 'genre row without a genre filter: ' + row.title);
    assert.ok(/^%[0-9A-F]{2}/.test(m[1]), 'genre name must be encoded: ' + m[1]);
    assert.ok(decodeURIComponent(m[1]).length > 2);
  });
});

test('the "now in cinemas" row asks for a real date window in Kinopoisk dd.mm.yyyy form', () => {
  const { _catalogRows } = load();
  const row = _catalogRows(new Date('2026-03-15T00:00:00Z')).find((r) => r.title === 'Сейчас в кино');

  const m = /premiere\.russia=([\d.]+)-([\d.]+)/.exec(row.url);
  assert.ok(m, 'expected a premiere window, got: ' + row.url);
  assert.match(m[1], /^\d{2}\.\d{2}\.\d{4}$/);
  assert.match(m[2], /^\d{2}\.\d{2}\.\d{4}$/);
});

test('date-based rows follow the clock, so the feed does not rot on a fixed year', () => {
  const { _catalogRows } = load();
  const a = _catalogRows(new Date('2026-06-01T00:00:00Z')).find((r) => r.title === 'Новинки кино');
  const b = _catalogRows(new Date('2030-06-01T00:00:00Z')).find((r) => r.title === 'Новинки кино');

  assert.ok(a.url.indexOf('year=2025-2026') >= 0, a.url);
  assert.ok(b.url.indexOf('year=2029-2030') >= 0, b.url);
});

test('listPath adds paging, the field whitelist and the poster gate', () => {
  const { _listPath } = load();
  const path = _listPath('type=movie&sortField=votes.kp&sortType=-1', 3);

  assert.ok(path.indexOf('v1.4/movie?type=movie') === 0, path);
  assert.ok(path.indexOf('&page=3') >= 0);
  assert.ok(path.indexOf('&limit=30') >= 0);
  assert.ok(path.indexOf('notNullFields=poster.url') >= 0, 'poster-less junk must be filtered server-side');
  assert.ok(path.indexOf('selectFields=id') >= 0, 'selectFields keeps the payload small on a TV');
  assert.ok(path.indexOf('selectFields=poster') >= 0);
});

test('listPath does not stack a second notNullFields when the row already has one', () => {
  const { _listPath } = load();
  const path = _listPath('type=movie&notNullFields=name', 1);
  assert.strictEqual(path.split('notNullFields=').length - 1, 1);
});

test('fieldsQuery repeats the parameter, which is how Kinopoisk takes arrays', () => {
  const { _fieldsQuery } = load();
  assert.strictEqual(_fieldsQuery(['id', 'name']), 'selectFields=id&selectFields=name');
});

test('list() returns a Lampa page for the row url', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const page = await new Promise((done) => KP.list({ url: 'type=movie&sortField=votes.kp', page: 2 }, done, done));

  assert.strictEqual(page.page, 1);        // from the canned response
  assert.strictEqual(page.total_pages, 7);
  assert.strictEqual(page.results.length, 2);
  assert.strictEqual(page.results[0].source, 'kp');
  assert.ok(mock.calls.requests[0].url.indexOf('page=2') >= 0, 'the requested page must reach the API');
});

test('main() loads the first batch of rows, each titled, none empty', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const parts = await new Promise((done) => KP.main({}, done, () => done([])));

  assert.ok(parts.length > 0);
  parts.forEach((part) => {
    assert.ok(part.title, 'a row without a title reached the feed');
    assert.ok(part.results.length, 'an empty row reached the feed');
    assert.ok(part.url, 'a row without a url has no working "more" grid');
  });
});

test('main() spends one request per row and no more', async () => {
  const mock = makeMock();
  const { KP, _quotaUsed } = loadPlugin(mock);

  const parts = await new Promise((done) => KP.main({}, done, () => done([])));

  assert.strictEqual(mock.calls.requests.length, parts.length);
  assert.strictEqual(_quotaUsed(), parts.length);
});

test('a second visit to the same feed is free — everything comes from cache', async () => {
  const mock = makeMock();
  const { KP, _quotaUsed } = loadPlugin(mock);

  await new Promise((done) => KP.main({}, done, () => done([])));
  const spent = _quotaUsed();

  await new Promise((done) => KP.main({}, done, () => done([])));

  assert.strictEqual(_quotaUsed(), spent, 'reopening the feed must not cost a single request');
});
