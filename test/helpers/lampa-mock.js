'use strict';
const path = require('path');

// --- minimal jQuery-like element ---
function makeEl(html) {
  return {
    _html: html || '',
    _handlers: {},
    _children: [],
    length: 1,
    on: function (ev, fn) { this._handlers[ev] = fn; return this; },
    append: function (child) { this._children.push(child); return this; },
    empty: function () { this._children = []; return this; },
    find: function () { return makeEl(''); },
    addClass: function () { return this; },
    removeClass: function () { return this; },
    text: function () { var m = /menu__text[^>]*>([^<]*)</.exec(this._html); return m ? m[1] : ''; },
    trigger: function (ev) { if (this._handlers[ev]) this._handlers[ev](); return this; }
  };
}

// ---------------------------------------------------------------------------
// Fixtures, shaped like the two real APIs.
// Both key on the same Kinopoisk id — that is what makes failover possible.
// ---------------------------------------------------------------------------

// kinopoisk.dev document
function devDoc(over) {
  return Object.assign({
    id: 1143242,
    name: 'Джентльмены',
    alternativeName: 'The Gentlemen',
    type: 'movie',
    isSeries: false,
    year: 2019,
    description: 'Один ушлый американец...',
    rating: { kp: 8.687, imdb: 7.8 },
    votes: { kp: 2601150 },
    poster: { previewUrl: 'https://kp/poster/300x450', url: 'https://kp/poster/600x900' },
    backdrop: { previewUrl: 'https://kp/back/small', url: 'https://kp/back/big' },
    genres: [{ id: 16, name: 'криминал' }, { id: 6, name: 'комедия' }],
    countries: [{ id: 1, name: 'США' }],
    movieLength: 113,
    externalId: { imdb: 'tt8367814', tmdb: 522627 }
  }, over || {});
}

function devSeriesDoc(over) {
  return devDoc(Object.assign({
    id: 464963,
    name: 'Игра престолов',
    alternativeName: 'Game of Thrones',
    type: 'tv-series',
    isSeries: true
  }, over || {}));
}

// kinopoiskapiunofficial.tech search item (v2.1: id is `filmId`)
function unofficialSearchDoc(over) {
  return Object.assign({
    filmId: 1143242,
    nameRu: 'Джентльмены',
    nameEn: 'The Gentlemen',
    type: 'FILM',
    year: '2019',
    description: 'Один ушлый американец...',
    filmLength: '1:53',
    countries: [{ country: 'США' }],
    genres: [{ genre: 'криминал' }, { genre: 'комедия' }],
    rating: '8.7',
    ratingVoteCount: 2601150,
    posterUrl: 'https://kpu/poster/big.jpg',
    posterUrlPreview: 'https://kpu/poster/small.jpg'
  }, over || {});
}

// kinopoiskapiunofficial.tech film document (v2.2: id is `kinopoiskId`)
function unofficialFilmDoc(over) {
  return Object.assign({
    kinopoiskId: 1143242,
    imdbId: 'tt8367814',
    nameRu: 'Джентльмены',
    nameOriginal: 'The Gentlemen',
    posterUrl: 'https://kpu/poster/big.jpg',
    posterUrlPreview: 'https://kpu/poster/small.jpg',
    coverUrl: 'https://kpu/cover.jpg',
    ratingKinopoisk: 8.687,
    ratingImdb: 7.8,
    ratingKinopoiskVoteCount: 2601150,
    year: 2019,
    filmLength: 113,
    slogan: 'Criminal. Class',
    description: 'Один ушлый американец...',
    type: 'FILM',
    serial: false,
    genres: [{ genre: 'криминал' }, { genre: 'комедия' }],
    countries: [{ country: 'США' }]
  }, over || {});
}

// --- mock factory ---
function makeMock(options) {
  options = options || {};
  var calls = {
    activityPush: [], listeners: {}, requests: [], clears: 0, noty: [],
    settingsComponents: [], settingsParams: []
  };

  var menuList = makeEl('');
  function $(arg) {
    if (typeof arg === 'string' && arg.charAt(0) === '<') return makeEl(arg);
    if (typeof arg === 'string') return { eq: function () { return menuList; }, length: 1 };
    return arg;
  }

  // Which provider a URL belongs to — tests assert on this constantly.
  function providerOf(url) {
    return url.indexOf('kinopoiskapiunofficial.tech') >= 0 ? 'kpu' : 'kpdev';
  }

  function defaultResponder(url) {
    if (providerOf(url) === 'kpu') {
      if (url.indexOf('search-by-keyword') >= 0) {
        return { pagesCount: 3, searchFilmsCountResult: 42, films: [unofficialSearchDoc(), unofficialSearchDoc({ filmId: 464963, nameRu: 'Игра престолов', nameEn: 'Game of Thrones', type: 'TV_SERIES' })] };
      }
      if (/\/films\/\d+\/seasons/.test(url)) {
        return { total: 2, items: [
          { number: 1, episodes: [{ seasonNumber: 1, episodeNumber: 1, nameRu: 'Зима близко', synopsis: 'ep', releaseDate: '2011-04-17' }] },
          { number: 2, episodes: [{ seasonNumber: 2, episodeNumber: 1, nameRu: 'Север помнит', releaseDate: '2012-04-01' }] }
        ] };
      }
      if (/\/films\/\d+/.test(url)) {
        if (url.indexOf('/films/464963') >= 0) return unofficialFilmDoc({ kinopoiskId: 464963, nameRu: 'Игра престолов', nameOriginal: 'Game of Thrones', type: 'TV_SERIES', serial: true });
        return unofficialFilmDoc();
      }
      return { films: [] };
    }

    // kinopoisk.dev
    if (url.indexOf('/movie/search') >= 0) {
      return { docs: [devDoc(), devSeriesDoc()], total: 2, page: 1, pages: 3, limit: 30 };
    }
    if (url.indexOf('/v1.4/season') >= 0) {
      return { docs: [
        { movieId: 464963, number: 1, name: 'Сезон 1', episodes: [{ number: 1, name: 'Зима близко', airDate: '2011-04-17T00:00:00.000Z', still: { url: 'https://kp/still/1' } }] },
        { movieId: 464963, number: 2, name: 'Сезон 2', episodes: [{ number: 1, name: 'Север помнит', airDate: '2012-04-01T00:00:00.000Z' }] }
      ], total: 2 };
    }
    if (/\/v1\.4\/movie\/\d+/.test(url)) {
      if (url.indexOf('/movie/464963') >= 0) return devSeriesDoc({ persons: [], similarMovies: [] });
      return devDoc({
        persons: [
          { id: 797, name: 'Мэттью Макконахи', enName: 'Matthew McConaughey', enProfession: 'actor', description: 'Michael', photo: 'https://kp/p/797' },
          { id: 5, name: 'Гай Ричи', enProfession: 'director', photo: 'https://kp/p/5' }
        ],
        similarMovies: [devDoc({ id: 526, name: 'Большой куш' })],
        slogan: 'Criminal. Class'
      });
    }
    return { docs: [] };
  }
  var responder = options.responder || defaultResponder;

  function Reguest() {
    this.timeout = function () {};
    this.silent = function (url, ok, err, post, params) {
      calls.requests.push({ url: url, provider: providerOf(url), params: params || {} });
      var json = responder(url);
      if (json && json.__error) {
        if (err) err({ status: json.__error, decode_code: json.__error });
        return;
      }
      ok(json);
    };
    this.clear = function () { calls.clears++; };
  }

  var store = {};
  if (options.storage) for (var sk in options.storage) if (options.storage.hasOwnProperty(sk)) store[sk] = options.storage[sk];

  var tmdbSource = { img: function (src, size) { return 'TMDB:' + src + ':' + (size || ''); } };
  var apiSources = {};
  Object.defineProperty(apiSources, 'tmdb', { get: function () { return tmdbSource; }, enumerable: true });

  var Lampa = {
    Listener: {
      follow: function (name, fn) { calls.listeners[name] = fn; },
      send: function (name, ev) { if (calls.listeners[name]) calls.listeners[name](ev); }
    },
    Activity: { push: function (o) { calls.activityPush.push(o); } },
    Component: { add: function () {} },
    Reguest: Reguest,
    Noty: { show: function (m) { calls.noty.push(m); } },
    Controller: { add: function () {}, toggle: function () {} },
    Storage: {
      field: function (k) { return (k in store) ? store[k] : 'undefined'; },
      get: function (k, def) { return (k in store) ? store[k] : def; },
      set: function (k, v) { store[k] = v; },
      listener: { follow: function () {}, send: function () {} }
    },
    Params: { select: function () {} },
    SettingsApi: {
      addComponent: function (c) { calls.settingsComponents.push(c); },
      addParam: function (p) { calls.settingsParams.push(p); }
    },
    Api: {
      sources: apiSources,
      img: function (src, size) { return tmdbSource.img(src, size); },
      partNext: function (parts, limit, partLoaded, partEmpty) { if (partEmpty) partEmpty(); }
    }
  };

  return {
    Lampa: Lampa, $: $, calls: calls, store: store, menuList: menuList,
    devDoc: devDoc, devSeriesDoc: devSeriesDoc,
    unofficialSearchDoc: unofficialSearchDoc, unofficialFilmDoc: unofficialFilmDoc
  };
}

// Load kinopoisk.js fresh with the given mock installed as globals.
function loadPlugin(mock, appready) {
  global.Lampa = mock.Lampa;
  global.$ = mock.$;
  global.window = { appready: !!appready };
  var p = path.resolve(__dirname, '..', '..', 'kinopoisk.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

// A mock where both providers have a token, so failover is actually exercised.
function makeDualMock(options) {
  options = options || {};
  options.storage = Object.assign({ kp_token_unofficial: 'KPU-KEY' }, options.storage || {});
  return makeMock(options);
}

module.exports = {
  makeMock: makeMock, makeDualMock: makeDualMock, loadPlugin: loadPlugin, makeEl: makeEl,
  devDoc: devDoc, devSeriesDoc: devSeriesDoc,
  unofficialSearchDoc: unofficialSearchDoc, unofficialFilmDoc: unofficialFilmDoc
};
