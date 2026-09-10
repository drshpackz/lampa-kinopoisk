'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin, kpDoc, kpSeriesDoc } = require('./helpers/lampa-mock');

function load() { return loadPlugin(makeMock()); }

test('a movie carries title/original_title and NOT name — that is how Lampa routes to method:movie', () => {
  const { _toCard } = load();
  const card = _toCard(kpDoc());

  assert.strictEqual(card.title, 'Джентльмены');
  assert.strictEqual(card.original_title, 'The Gentlemen');
  assert.strictEqual(card.name, undefined);
  assert.strictEqual(card.original_name, undefined, 'original_name on a movie would open it as a series');
  assert.strictEqual(card.release_date, '2019-01-01');
});

test('a series carries name/original_name and NOT title', () => {
  const { _toCard } = load();
  const card = _toCard(kpSeriesDoc());

  assert.strictEqual(card.name, 'Игра престолов');
  assert.strictEqual(card.original_name, 'Game of Thrones');
  assert.strictEqual(card.title, undefined);
  assert.strictEqual(card.first_air_date, '2019-01-01');
});

test('INVARIANT: poster_path is never set — Api.img() would prepend the TMDB host to a Kinopoisk URL', () => {
  const { _toCard } = load();
  const card = _toCard(kpDoc());

  assert.strictEqual(card.poster_path, undefined);
  assert.strictEqual(card.backdrop_path, undefined);
  assert.strictEqual(card.poster, 'https://kp/poster/300x450');
  assert.strictEqual(card.img, 'https://kp/poster/300x450');
  assert.strictEqual(card.background_image, 'https://kp/back/1344x756');
});

test('ids that online balancers need survive onto the card', () => {
  const { _toCard } = load();
  const card = _toCard(kpDoc());

  assert.strictEqual(card.id, 1143242);
  assert.strictEqual(card.kinopoisk_id, 1143242);
  assert.strictEqual(card.imdb_id, 'tt8367814');
  assert.strictEqual(card.source, 'kp');
});

test('vote_average is the Kinopoisk rating, with imdb kept alongside', () => {
  const { _toCard } = load();
  const card = _toCard(kpDoc());

  assert.strictEqual(card.vote_average, 8.687);
  assert.strictEqual(card.imdb_rating, 7.8);
  assert.strictEqual(card.vote_count, 2601150);
});

test('kp_rating is NOT set — Lampa labels the vote_average badge "KP" for this source, so it would show twice', () => {
  const { _toCard } = load();
  assert.strictEqual(_toCard(kpDoc()).kp_rating, undefined);
});

test('rating falls back to imdb, then tmdb, when Kinopoisk has none', () => {
  const { _toCard } = load();
  assert.strictEqual(_toCard(kpDoc({ rating: { imdb: 7.1 } })).vote_average, 7.1);
  assert.strictEqual(_toCard(kpDoc({ rating: { tmdb: 6.2 } })).vote_average, 6.2);
  assert.strictEqual(_toCard(kpDoc({ rating: {} })).vote_average, 0);
});

test('animated-series counts as a series, cartoon and anime do not', () => {
  const { _isSeries } = load();
  assert.strictEqual(_isSeries({ type: 'animated-series' }), true);
  assert.strictEqual(_isSeries({ type: 'tv-series' }), true);
  assert.strictEqual(_isSeries({ type: 'cartoon' }), false);
  assert.strictEqual(_isSeries({ type: 'anime' }), false);
  // explicit isSeries wins over type
  assert.strictEqual(_isSeries({ type: 'movie', isSeries: true }), true);
});

test('a doc without an id is dropped instead of becoming a broken card', () => {
  const { _toCard, _toCards } = load();
  assert.strictEqual(_toCard({ name: 'нет id' }), null);
  assert.strictEqual(_toCard(null), null);
  assert.strictEqual(_toCards([kpDoc(), null, { name: 'нет id' }]).length, 1);
});

test('a doc with only an English name still gets both title fields', () => {
  const { _toCard } = load();
  const card = _toCard(kpDoc({ name: null, alternativeName: null, enName: 'Some Movie' }));
  assert.strictEqual(card.title, 'Some Movie');
  assert.strictEqual(card.original_title, 'Some Movie');
});

test('toPage maps the Kinopoisk envelope onto Lampa paging', () => {
  const { _toPage } = load();
  const page = _toPage({ docs: [kpDoc()], page: 3, pages: 7, total: 200 }, 'type=movie');

  assert.strictEqual(page.page, 3);
  assert.strictEqual(page.total_pages, 7);
  assert.strictEqual(page.total_results, 200);
  assert.strictEqual(page.url, 'type=movie');
  assert.strictEqual(page.source, 'kp');
  assert.strictEqual(page.results.length, 1);
});
