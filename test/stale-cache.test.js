'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

// ---------------------------------------------------------------------------
// The bug a user hit after the production_companies fix shipped: the card they
// opened was served from the plugin's own cache, which still held the object
// the PREVIOUS version had built — without production_companies. Lampa threw
// "Cannot read properties of undefined (reading 'length')" in
// Descriptiopn.create and the card never finished loading.
//
// Two defences, both tested here: the cache key is versioned, so a new shape
// never meets an old entry; and full() normalises whatever it hands Lampa, so
// even an old or odd entry cannot reach an unguarded .length.
// ---------------------------------------------------------------------------

// Exactly what the broken version cached for «Завод»: no production_companies.
function oldShapeEntry() {
  return {
    until: Date.now() + 7 * 24 * 3600 * 1000,
    at: Date.now(),
    data: {
      movie: {
        source: 'kp', id: 993591, kinopoisk_id: 993591,
        title: 'Завод', original_title: 'Завод', release_date: '2018-01-01',
        overview: 'Посреди дня похищен олигарх...',
        genres: [{ id: 0, name: 'триллер' }],
        production_countries: [{ name: 'Россия' }]
        // production_companies: missing — the whole bug
      },
      persons: { id: 0, cast: [], crew: [] },
      simular: { results: [] }
    }
  };
}

function fullOf(mock, id) {
  const { KP } = loadPlugin(mock);
  return new Promise((resolve, reject) => KP.full({ id: id, method: 'movie' }, resolve, reject));
}

test('the cache key is versioned, so a new build never reads an old build\'s entries', () => {
  const { _CACHE_KEY } = loadPlugin(makeMock());
  assert.notStrictEqual(_CACHE_KEY, 'kp_cache', 'the unversioned key is exactly what served the stale card');
  assert.match(_CACHE_KEY, /_v\d+$/);
});

test('an entry left under the legacy key is ignored — the card is fetched fresh', async () => {
  const mock = makeMock({ storage: { kp_cache: { 'full|993591': oldShapeEntry() } } });
  await fullOf(mock, 993591);

  assert.strictEqual(mock.calls.requests.length, 1, 'the legacy entry must not satisfy the request');
});

test('start() frees the legacy cache so it stops occupying localStorage', () => {
  const mock = makeMock({ storage: { kp_cache: { 'full|993591': oldShapeEntry() } } });
  loadPlugin(mock)._start();

  assert.strictEqual(mock.store.kp_cache, null);
});

test('even an old-shape entry under the CURRENT key reaches Lampa safely', async () => {
  // Belt and braces: whatever the cache holds, full() must not hand Lampa a
  // movie that throws on an unguarded .length.
  const mock = makeMock();
  const { _CACHE_KEY } = loadPlugin(mock);
  mock.store[_CACHE_KEY] = { 'full|993591': oldShapeEntry() };

  const data = await fullOf(mock, 993591);

  assert.strictEqual(mock.calls.requests.length, 0, 'served from cache');
  assert.ok(Array.isArray(data.movie.production_companies), 'production_companies must be an array');
  assert.ok(Array.isArray(data.movie.genres));
  assert.strictEqual(data.movie.title, 'Завод');
});

test('ensureMovie guarantees every field Lampa dereferences unguarded', () => {
  // The four accesses found in Lampa's full-card modules:
  //   card.genres.length, card.genres.slice,
  //   card.production_companies.length, card.title.length
  const { _ensureMovie } = loadPlugin(makeMock());

  const m = _ensureMovie({ id: 1 });
  assert.deepStrictEqual(m.genres, []);
  assert.deepStrictEqual(m.production_companies, []);
  assert.deepStrictEqual(m.production_countries, []);
  assert.strictEqual(typeof m.title, 'string');
  assert.strictEqual(typeof m.overview, 'string');
});

test('ensureMovie never turns a series into a movie', () => {
  // A title on a series would not change routing, but the name must survive so
  // Lampa can derive the title itself.
  const { _ensureMovie } = loadPlugin(makeMock());
  const s = _ensureMovie({ id: 2, original_name: 'Game of Thrones' });

  assert.strictEqual(s.name, 'Game of Thrones');
  assert.strictEqual(s.title, undefined, 'a series must not gain a title field');
  assert.strictEqual(s.original_name, 'Game of Thrones');
});

test('ensureMovie leaves good data alone', () => {
  const { _ensureMovie } = loadPlugin(makeMock());
  const genres = [{ id: 1, name: 'драма' }];
  const m = _ensureMovie({ title: 'X', genres: genres, production_companies: [{ name: 'HBO' }] });

  assert.strictEqual(m.genres, genres, 'same array, not a copy');
  assert.strictEqual(m.production_companies[0].name, 'HBO');
  assert.strictEqual(m.title, 'X');
});

test('missing persons or similar blocks are filled in too', async () => {
  const mock = makeMock();
  const { _CACHE_KEY } = loadPlugin(mock);
  const entry = oldShapeEntry();
  delete entry.data.persons;
  delete entry.data.simular;
  mock.store[_CACHE_KEY] = { 'full|993591': entry };

  const data = await fullOf(mock, 993591);

  assert.ok(Array.isArray(data.persons.cast));
  assert.ok(Array.isArray(data.simular.results));
});
