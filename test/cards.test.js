'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin, devDoc, devSeriesDoc, unofficialSearchDoc, unofficialFilmDoc } = require('./helpers/lampa-mock');

function load() { return loadPlugin(makeMock()); }

// ---------------------------------------------------------------------------
// The whole point of two providers is that a card looks identical whichever
// one produced it. These are the rules both mappers must obey.
// ---------------------------------------------------------------------------

test('kinopoisk.dev: a movie carries title/original_title and NOT name', () => {
  const { _devCard } = load();
  const card = _devCard(devDoc());

  assert.strictEqual(card.title, 'Джентльмены');
  assert.strictEqual(card.original_title, 'The Gentlemen');
  assert.strictEqual(card.name, undefined);
  assert.strictEqual(card.original_name, undefined, 'original_name on a movie would open it as a series');
  assert.strictEqual(card.release_date, '2019-01-01');
});

test('kinopoiskapiunofficial: a movie carries title/original_title and NOT name', () => {
  const { _unofficialCard } = load();
  const card = _unofficialCard(unofficialSearchDoc());

  assert.strictEqual(card.title, 'Джентльмены');
  assert.strictEqual(card.original_title, 'The Gentlemen');
  assert.strictEqual(card.name, undefined);
  assert.strictEqual(card.original_name, undefined);
  assert.strictEqual(card.release_date, '2019-01-01');
});

test('kinopoisk.dev: a series carries name/original_name and NOT title', () => {
  const { _devCard } = load();
  const card = _devCard(devSeriesDoc());

  assert.strictEqual(card.name, 'Игра престолов');
  assert.strictEqual(card.original_name, 'Game of Thrones');
  assert.strictEqual(card.title, undefined);
});

test('kinopoiskapiunofficial: TV_SERIES / MINI_SERIES / TV_SHOW are series, FILM is not', () => {
  const { _unofficialIsSeries } = load();
  assert.strictEqual(_unofficialIsSeries({ type: 'TV_SERIES' }), true);
  assert.strictEqual(_unofficialIsSeries({ type: 'MINI_SERIES' }), true);
  assert.strictEqual(_unofficialIsSeries({ type: 'TV_SHOW' }), true);
  assert.strictEqual(_unofficialIsSeries({ type: 'FILM' }), false);
  assert.strictEqual(_unofficialIsSeries({ type: 'FILM', serial: true }), true, 'serial:true wins over type');
});

test('INVARIANT: neither provider ever sets poster_path', () => {
  // Api.img() unconditionally prepends the TMDB image host, which would turn a
  // ready-made Kinopoisk URL into a broken one.
  const { _devCard, _unofficialCard } = load();
  [_devCard(devDoc()), _unofficialCard(unofficialSearchDoc()), _unofficialCard(unofficialFilmDoc())]
    .forEach((card) => {
      assert.strictEqual(card.poster_path, undefined);
      assert.strictEqual(card.backdrop_path, undefined);
      assert.ok(/^https?:\/\//.test(card.poster), 'poster must be a ready URL: ' + card.poster);
      assert.strictEqual(card.img, card.poster);
    });
});

test('both providers produce the same identity fields for the same title', () => {
  const { _devCard, _unofficialCard } = load();
  const a = _devCard(devDoc());
  const b = _unofficialCard(unofficialFilmDoc());

  assert.strictEqual(a.id, b.id, 'the Kinopoisk id is what makes failover possible');
  assert.strictEqual(a.kinopoisk_id, b.kinopoisk_id);
  assert.strictEqual(a.imdb_id, b.imdb_id);
  assert.strictEqual(a.source, 'kp');
  assert.strictEqual(b.source, 'kp');
  assert.strictEqual(a.title, b.title);
  assert.strictEqual(a.original_title, b.original_title);
  assert.strictEqual(a.vote_average, b.vote_average);
});

test('the unofficial search item uses filmId, the film document uses kinopoiskId', () => {
  const { _unofficialCard } = load();
  assert.strictEqual(_unofficialCard(unofficialSearchDoc()).id, 1143242);
  assert.strictEqual(_unofficialCard(unofficialFilmDoc()).id, 1143242);
  assert.strictEqual(_unofficialCard({ nameRu: 'без id' }), null);
});

test('kp_rating is never set — Lampa labels the vote_average badge "KP" for this source', () => {
  const { _devCard, _unofficialCard } = load();
  assert.strictEqual(_devCard(devDoc()).kp_rating, undefined);
  assert.strictEqual(_unofficialCard(unofficialFilmDoc()).kp_rating, undefined);
});

test('ratings and vote counts survive both mappings', () => {
  const { _devCard, _unofficialCard } = load();
  const a = _devCard(devDoc());
  const b = _unofficialCard(unofficialFilmDoc());

  assert.strictEqual(a.vote_average, 8.687);
  assert.strictEqual(a.imdb_rating, 7.8);
  assert.strictEqual(b.vote_average, 8.687);
  assert.strictEqual(b.imdb_rating, 7.8);
  assert.strictEqual(b.vote_count, 2601150);
});

test('the unofficial mapper reads numbers that arrive as strings', () => {
  // v2.1 sends year and rating as strings; a string year would break the date.
  const { _unofficialCard } = load();
  const card = _unofficialCard(unofficialSearchDoc({ year: '1999', rating: '7.5' }));
  assert.strictEqual(card.release_date, '1999-01-01');
  assert.strictEqual(card.vote_average, 7.5);
});

test('an unrated title gets 0 rather than NaN', () => {
  const { _unofficialCard, _devCard } = load();
  assert.strictEqual(_unofficialCard(unofficialSearchDoc({ rating: 'null' })).vote_average, 0);
  assert.strictEqual(_devCard(devDoc({ rating: {} })).vote_average, 0);
});

test('the full movie object carries genres, countries, runtime and tagline from either provider', () => {
  const { _devMovie, _KPU } = load();
  const a = _devMovie(devDoc({ slogan: 'Criminal. Class' }));
  const b = _KPU.parseFull(unofficialFilmDoc()).movie;

  assert.deepStrictEqual(a.genres.map((g) => g.name), ['криминал', 'комедия']);
  assert.deepStrictEqual(b.genres.map((g) => g.name), ['криминал', 'комедия']);
  assert.deepStrictEqual(a.production_countries.map((c) => c.name), ['США']);
  assert.deepStrictEqual(b.production_countries.map((c) => c.name), ['США']);
  assert.strictEqual(a.runtime, 113);
  assert.strictEqual(b.runtime, 113);
  assert.strictEqual(b.tagline, 'Criminal. Class');
});

test('actors from kinopoisk.dev land in cast, everyone else in crew', () => {
  const { _devPersons } = load();
  const p = _devPersons([
    { id: 1, name: 'Актёр', enProfession: 'actor', description: 'Роль' },
    { id: 2, name: 'Режиссёр', enProfession: 'director' }
  ]);

  assert.strictEqual(p.cast.length, 1);
  assert.strictEqual(p.cast[0].character, 'Роль');
  assert.strictEqual(p.crew.length, 1);
  assert.strictEqual(p.crew[0].job, 'Director', 'Lampa looks for the English job name');
});


// ---------------------------------------------------------------------------
// Edge cases the live API actually produces (verified against real responses):
// nameOriginal comes back as an empty string for Russian titles, and episode
// fields come back as null.
// ---------------------------------------------------------------------------

test('a series whose original name is empty still routes as a series', () => {
  // «Завод» (TV_SERIES) has nameOriginal: '' and nameEn: null. An empty
  // original_name would make Lampa open it as a movie — no seasons, no episodes.
  const { _unofficialCard, _devCard } = load();

  const kpu = _unofficialCard({ filmId: 5253113, nameRu: 'Завод', nameEn: null, nameOriginal: '', type: 'TV_SERIES', year: '2023' });
  assert.strictEqual(kpu.name, 'Завод');
  assert.ok(kpu.original_name, 'original_name must not be empty: ' + JSON.stringify(kpu.original_name));
  assert.strictEqual(kpu.title, undefined);

  const dev = _devCard(devSeriesDoc({ name: 'Завод', alternativeName: '', enName: '' }));
  assert.ok(dev.original_name);
});

test('a movie with no original title falls back to the Russian one', () => {
  const { _unofficialCard } = load();
  const card = _unofficialCard({ kinopoiskId: 993591, nameRu: 'Завод', nameEn: '', nameOriginal: '', type: 'FILM', year: 2018 });
  assert.strictEqual(card.title, 'Завод');
  assert.strictEqual(card.original_title, 'Завод');
});

test('a nameless document is dropped rather than rendered as a blank card', () => {
  const { _unofficialCard, _devCard } = load();
  assert.strictEqual(_unofficialCard({ filmId: 1, nameRu: '', nameEn: '', nameOriginal: '' }), null);
  assert.strictEqual(_devCard({ id: 1 }), null);
});

test('episodes with null fields get readable fallbacks', () => {
  // The real seasons response returns nameRu, synopsis and releaseDate as null.
  const { _KPU } = load();
  const map = _KPU.parseSeasons({ items: [{ number: 1, episodes: [
    { seasonNumber: 1, episodeNumber: 1, nameRu: null, nameEn: null, synopsis: null, releaseDate: null }
  ] }] });

  assert.strictEqual(map[1].episodes[0].name, 'Серия 1');
  assert.strictEqual(map[1].episodes[0].overview, '');
  assert.strictEqual(map[1].episodes[0].air_date, '');
});


test('CONTRACT: a full movie object carries every array Lampa dereferences unguarded', () => {
  // Lampa's description module does `card.genres.length` and
  // `card.production_companies.length` with no undefined check. A missing array
  // throws inside Lampa, the exception is swallowed, and the card stays on the
  // loading spinner forever — no console error a user would ever see.
  const { _devMovie, _KPU } = load();
  const movies = [
    _devMovie(devDoc()),
    _devMovie(devSeriesDoc()),
    _KPU.parseFull(unofficialFilmDoc()).movie
  ];

  movies.forEach((m) => {
    ['genres', 'production_companies', 'production_countries'].forEach((field) => {
      assert.ok(Array.isArray(m[field]), field + ' must be an array, got ' + typeof m[field]);
    });
  });
});

test('a title with no companies still gets an empty array, not undefined', () => {
  const { _devMovie, _KPU } = load();
  assert.deepStrictEqual(_devMovie(devDoc({ networks: null })).production_companies, []);
  assert.deepStrictEqual(_KPU.parseFull(unofficialFilmDoc()).production_companies, undefined);
  assert.deepStrictEqual(_KPU.parseFull(unofficialFilmDoc()).movie.production_companies, []);
});

test('networks from kinopoisk.dev become production companies', () => {
  const { _devMovie } = load();
  const m = _devMovie(devSeriesDoc({ networks: { items: [{ name: 'HBO' }] } }));
  assert.deepStrictEqual(m.production_companies.map((c) => c.name), ['HBO']);
});
