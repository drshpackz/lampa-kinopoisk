'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, makeDualMock, loadPlugin, devSeriesDoc, unofficialFilmDoc } = require('./helpers/lampa-mock');

function fullOf(mock, params) {
  const { KP } = loadPlugin(mock);
  return new Promise((resolve, reject) => KP.full(params, resolve, () => reject(new Error('full() failed'))));
}

test('a movie card is one request and arrives in the shape the Full component reads', async () => {
  const mock = makeMock();
  const data = await fullOf(mock, { id: 1143242, method: 'movie' });

  assert.ok(data.movie, 'data.movie is what Lampa renders');
  assert.strictEqual(data.movie.title, 'Джентльмены');
  assert.strictEqual(data.movie.source, 'kp');
  assert.strictEqual(data.movie.tagline, 'Criminal. Class');
  assert.strictEqual(data.movie.runtime, 113);
  assert.ok(data.persons.cast.length, 'kinopoisk.dev hands over the cast for free');
  assert.ok(data.simular.results.length);
  assert.strictEqual(mock.calls.requests.length, 1, 'a movie card must cost exactly one request');
});

test('a movie never triggers a seasons request', async () => {
  const mock = makeMock();
  await fullOf(mock, { id: 1143242, method: 'movie' });
  assert.ok(!mock.calls.requests.some((r) => r.url.indexOf('season') >= 0));
});

test('a series loads its seasons and hands Lampa the newest one', async () => {
  const mock = makeMock();
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.name, 'Игра престолов');
  assert.strictEqual(data.movie.original_name, 'Game of Thrones', 'this is what routes it as tv');
  assert.strictEqual(data.movie.number_of_seasons, 2);
  assert.strictEqual(data.movie.number_of_episodes, 2);
  assert.strictEqual(data.episodes.season_number, 2);
  assert.strictEqual(data.episodes.episodes[0].name, 'Север помнит');
  assert.strictEqual(mock.calls.requests.length, 2, 'film document + seasons');
});

test('the card and the episodes screen share one seasons request', async () => {
  const mock = makeMock();
  const { KP, _quotaUsed, _KPDEV } = loadPlugin(mock);

  await new Promise((res, rej) => KP.full({ id: 464963, method: 'tv' }, res, rej));
  const spent = _quotaUsed(_KPDEV);

  await new Promise((done) => KP.seasons({ id: 464963 }, [1, 2], done));

  assert.strictEqual(_quotaUsed(_KPDEV), spent, 'opening the episodes screen must be free after the card');
});

test('seasons() returns only the seasons Lampa asked for', async () => {
  const { KP } = loadPlugin(makeMock());
  const res = await new Promise((done) => KP.seasons({ id: 464963 }, [2], done));

  assert.deepStrictEqual(Object.keys(res), ['2']);
  assert.strictEqual(res['2'].episodes[0].name, 'Север помнит');
});

test('seasons() answers with an empty map instead of hanging when the request fails', async () => {
  const { KP } = loadPlugin(makeMock({ responder: () => ({ __error: 500 }) }));
  const res = await new Promise((done) => KP.seasons({ id: 1 }, [1], done));
  assert.deepStrictEqual(res, {});
});

test('the unofficial provider produces the same season structure', async () => {
  // Its seasons live at a different path and name their fields differently, but
  // what reaches Lampa has to be indistinguishable.
  const mock = makeDualMock({
    responder: (url) => {
      if (url.indexOf('poiskkino') >= 0) return { __error: 403 };
      if (/\/films\/\d+\/seasons/.test(url)) {
        return { items: [{ number: 1, episodes: [
          { seasonNumber: 1, episodeNumber: 1, nameRu: 'Первая', synopsis: 'о чём', releaseDate: '2011-04-17' },
          { seasonNumber: 1, episodeNumber: 2, nameRu: 'Вторая' }
        ] }] };
      }
      return unofficialFilmDoc({ kinopoiskId: 464963, nameRu: 'Сериал', nameOriginal: 'Series', type: 'TV_SERIES', serial: true });
    }
  });
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.name, 'Сериал');
  assert.strictEqual(data.movie.number_of_seasons, 1);
  assert.strictEqual(data.movie.number_of_episodes, 2);
  assert.strictEqual(data.episodes.episodes[0].name, 'Первая');
  assert.strictEqual(data.episodes.episodes[0].air_date, '2011-04-17');
  assert.strictEqual(data.episodes.episodes[1].name, 'Вторая');
});

test('an episode never gets a still_path — that would go through the TMDB image host', async () => {
  const { KP } = loadPlugin(makeMock());
  const res = await new Promise((done) => KP.seasons({ id: 464963 }, [1], done));
  const ep = res['1'].episodes[0];

  assert.strictEqual(ep.still_path, null);
  assert.strictEqual(ep.img, 'https://kp/still/1');
  assert.strictEqual(ep.air_date, '2011-04-17');
  assert.strictEqual(ep.episode_number, 1);
  assert.strictEqual(ep.season_number, 1);
});

test('specials (season 0) do not inflate the season count but stay listed', () => {
  const { _applySeasons, _lastSeason } = loadPlugin(makeMock());
  const map = {
    0: { id: 'x-0', season_number: 0, name: 'Спецвыпуски', overview: '', episodes: [{ air_date: '' }] },
    1: { id: 'x-1', season_number: 1, name: 'Сезон 1', overview: '', episodes: [{ air_date: '2011-01-01' }] }
  };
  const movie = _applySeasons({}, map);

  assert.strictEqual(movie.number_of_seasons, 1, 'season 0 is not a season');
  assert.strictEqual(movie.seasons.length, 2, 'but it is still reachable');
  assert.strictEqual(_lastSeason(map).season_number, 1, 'the card shows a real season, not the specials');
});

test('when the seasons request fails the card still opens, just without counts', async () => {
  const mock = makeMock({
    responder: (url) => (/\/v1\.4\/movie\/\d+/.test(url)
      ? devSeriesDoc({ persons: [], similarMovies: [] })
      : { __error: 500 })
  });
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.name, 'Игра престолов');
  assert.strictEqual(data.movie.number_of_seasons, undefined);
  assert.strictEqual(data.episodes, undefined);
});

test('an empty document fails instead of rendering a blank card', async () => {
  const { KP } = loadPlugin(makeMock({ responder: () => ({}) }));
  const failed = await new Promise((resolve) => KP.full({ id: 1 }, () => resolve(false), () => resolve(true)));
  assert.strictEqual(failed, true);
});

test('full() without an id fails immediately rather than requesting /movie/undefined', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const failed = await new Promise((resolve) => KP.full({}, () => resolve(false), () => resolve(true)));
  assert.strictEqual(failed, true);
  assert.strictEqual(mock.calls.requests.length, 0);
});

test('a card found on one provider opens on the other', async () => {
  // Both APIs key on the same Kinopoisk id, so a title found via the unofficial
  // search must still open when only kinopoisk.dev has budget, and vice versa.
  const mock = makeDualMock({
    responder: (url) => (url.indexOf('poiskkino') >= 0 ? { __error: 403 } : unofficialFilmDoc())
  });
  const data = await fullOf(mock, { id: 1143242, method: 'movie' });

  assert.strictEqual(data.movie.title, 'Джентльмены');
  assert.strictEqual(data.movie.id, 1143242);
  assert.deepStrictEqual(mock.calls.requests.map((r) => r.provider), ['kpdev', 'kpu']);
});
