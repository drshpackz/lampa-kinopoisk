'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin, kpDoc, kpSeriesDoc } = require('./helpers/lampa-mock');

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
  assert.ok(data.persons, 'data.persons drives the cast row');
  assert.ok(data.simular.results.length, 'similar titles come free with the Kinopoisk document');
  assert.strictEqual(mock.calls.requests.length, 1, 'a movie card must cost exactly one request');
});

test('the movie object carries the fields the card page shows', async () => {
  const data = await fullOf(makeMock(), { id: 1143242, method: 'movie' });
  const m = data.movie;

  assert.strictEqual(m.tagline, 'Criminal. Class');
  assert.strictEqual(m.runtime, 113);
  assert.deepStrictEqual(m.genres.map((g) => g.name), ['криминал', 'комедия']);
  assert.deepStrictEqual(m.production_countries.map((c) => c.name), ['США']);
  assert.strictEqual(m.background_image, 'https://kp/back/1344x756');
  assert.strictEqual(m.imdb_id, 'tt8367814');
});

test('actors land in cast with a character, everyone else in crew with a job', async () => {
  const data = await fullOf(makeMock(), { id: 1143242, method: 'movie' });

  assert.strictEqual(data.persons.cast.length, 1);
  assert.strictEqual(data.persons.cast[0].name, 'Мэттью Макконахи');
  assert.strictEqual(data.persons.cast[0].character, 'Michael');
  assert.strictEqual(data.persons.cast[0].img, 'https://kp/p/797');

  assert.strictEqual(data.persons.crew.length, 1);
  assert.strictEqual(data.persons.crew[0].job, 'Director', 'Lampa looks for the English job name');
});

test('a series card also loads its seasons and hands Lampa the last one', async () => {
  const mock = makeMock({
    responder: (url) => {
      if (/\/v1\.4\/movie\/\d+/.test(url)) return kpSeriesDoc({ persons: [], similarMovies: [] });
      if (url.indexOf('/v1.4/season') >= 0) {
        return {
          docs: [
            { movieId: 464963, number: 1, episodes: [{ number: 1, name: 'Зима близко', airDate: '2011-04-17T00:00:00.000Z' }] },
            { movieId: 464963, number: 2, episodes: [{ number: 1, name: 'Север помнит', airDate: '2012-04-01T00:00:00.000Z' }] }
          ]
        };
      }
      return { docs: [] };
    }
  });
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.name, 'Игра престолов');
  // Counts come from the real season documents, not from the movie document —
  // /v1.4/movie/{id} does not return seasonsInfo at all.
  assert.strictEqual(data.movie.number_of_seasons, 2);
  assert.strictEqual(data.movie.number_of_episodes, 2, 'one episode per season in this fixture');
  assert.strictEqual(data.movie.seasons.length, 2);
  assert.strictEqual(data.movie.seasons[1].episode_count, 1);
  assert.ok(data.episodes, 'the episodes block feeds the season strip');
  assert.strictEqual(data.episodes.season_number, 2, 'the newest season is the one Lampa shows');
  assert.strictEqual(mock.calls.requests.length, 2, 'movie document + seasons');
});

test('a series is asked for its seasons even though the movie document has no seasonsInfo', async () => {
  const mock = makeMock({
    responder: (url) => {
      if (/\/v1\.4\/movie\/\d+/.test(url)) return kpSeriesDoc({ seasonsInfo: null, persons: [], similarMovies: [] });
      if (url.indexOf('/v1.4/season') >= 0) {
        return { docs: [{ movieId: 464963, number: 1, episodes: [{ number: 1, name: 'Пилот' }, { number: 2, name: 'Второй' }] }] };
      }
      return { docs: [] };
    }
  });
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.number_of_seasons, 1);
  assert.strictEqual(data.movie.number_of_episodes, 2);
  assert.strictEqual(data.episodes.episodes.length, 2);
});

test('specials (season 0) do not inflate the season count but stay reachable', async () => {
  const mock = makeMock({
    responder: (url) => {
      if (/\/v1\.4\/movie\/\d+/.test(url)) return kpSeriesDoc({ seasonsInfo: null, persons: [], similarMovies: [] });
      if (url.indexOf('/v1.4/season') >= 0) {
        return { docs: [
          { movieId: 1, number: 0, episodes: [{ number: 1, name: 'Спецвыпуск' }] },
          { movieId: 1, number: 1, episodes: [{ number: 1, name: 'Первая' }] }
        ] };
      }
      return { docs: [] };
    }
  });
  const data = await fullOf(mock, { id: 1, method: 'tv' });

  assert.strictEqual(data.movie.number_of_seasons, 1, 'season 0 is not a season');
  assert.strictEqual(data.movie.seasons.length, 2, 'but it is still listed');
  assert.strictEqual(data.episodes.season_number, 1, 'the card shows a real season, not the specials');
});

test('when the seasons request fails the card still opens, just without counts', async () => {
  const mock = makeMock({
    responder: (url) => {
      if (/\/v1\.4\/movie\/\d+/.test(url)) return kpSeriesDoc({ seasonsInfo: null, persons: [], similarMovies: [] });
      return { __error: 500 };
    }
  });
  const data = await fullOf(mock, { id: 464963, method: 'tv' });

  assert.strictEqual(data.movie.name, 'Игра престолов');
  assert.strictEqual(data.movie.number_of_seasons, 0);
  assert.strictEqual(data.episodes, undefined);
});

test('the card and the episodes screen share one seasons request', async () => {
  const mock = makeMock();
  const { KP, _quotaUsed } = loadPlugin(mock);

  await new Promise((resolve, reject) => KP.full({ id: 464963, method: 'tv' }, resolve, reject));
  const spent = _quotaUsed();

  await new Promise((done) => KP.seasons({ id: 464963 }, [1, 2], done));

  assert.strictEqual(_quotaUsed(), spent, 'opening the episodes screen must be free after the card');
});

test('a movie never triggers a seasons request', async () => {
  const mock = makeMock();
  await fullOf(mock, { id: 1143242, method: 'movie' });
  assert.ok(!mock.calls.requests.some((r) => r.url.indexOf('/season') >= 0));
});

test('an empty document fails instead of rendering a blank card', async () => {
  const mock = makeMock({ responder: () => ({}) });
  const { KP } = loadPlugin(mock);

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

test('an episode keeps its still, air date and number', async () => {
  const { _toEpisode } = loadPlugin(makeMock());
  const ep = _toEpisode({ number: 4, name: 'Ep', airDate: '2011-05-08T00:00:00.000Z', description: 'd', still: { url: 'https://kp/s/4' } }, 2);

  assert.strictEqual(ep.episode_number, 4);
  assert.strictEqual(ep.season_number, 2);
  assert.strictEqual(ep.air_date, '2011-05-08');
  assert.strictEqual(ep.img, 'https://kp/s/4');
  assert.strictEqual(ep.still_path, null, 'still_path would be sent through the TMDB image host');
});

test('an unnamed episode gets a readable fallback name', async () => {
  const { _toEpisode } = loadPlugin(makeMock());
  assert.strictEqual(_toEpisode({ number: 7 }, 1).name, 'Серия 7');
});

test('seasons() returns only the seasons Lampa asked for', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  const res = await new Promise((done) => KP.seasons({ id: 464963 }, [2], done));

  assert.deepStrictEqual(Object.keys(res), ['2']);
  assert.strictEqual(res['2'].episodes[0].name, 'Север помнит');
});

test('seasons() answers with an empty map instead of hanging when the request fails', async () => {
  const mock = makeMock({ responder: () => ({ __error: 500 }) });
  const { KP } = loadPlugin(mock);

  const res = await new Promise((done) => KP.seasons({ id: 1 }, [1], done));
  assert.deepStrictEqual(res, {});
});
