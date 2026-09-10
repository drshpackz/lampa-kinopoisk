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

// A Kinopoisk list document, shaped exactly like a real /v1.4/movie doc.
function kpDoc(over) {
  return Object.assign({
    id: 1143242,
    name: 'Джентльмены',
    alternativeName: 'The Gentlemen',
    type: 'movie',
    isSeries: false,
    year: 2019,
    description: 'Один ушлый американец...',
    shortDescription: 'Гангстеры делят бизнес',
    rating: { kp: 8.687, imdb: 7.8 },
    votes: { kp: 2601150, imdb: 454000 },
    poster: { previewUrl: 'https://kp/poster/300x450', url: 'https://kp/poster/600x900' },
    backdrop: { previewUrl: 'https://kp/back/678x380', url: 'https://kp/back/1344x756' },
    genres: [{ id: 16, name: 'криминал' }, { id: 6, name: 'комедия' }],
    countries: [{ id: 1, name: 'США' }],
    movieLength: 113,
    ageRating: 18,
    externalId: { imdb: 'tt8367814', tmdb: 522627 }
  }, over || {});
}

function kpSeriesDoc(over) {
  return kpDoc(Object.assign({
    id: 464963,
    name: 'Игра престолов',
    alternativeName: 'Game of Thrones',
    type: 'tv-series',
    isSeries: true,
    seasonsInfo: [{ number: 1, episodesCount: 10 }, { number: 2, episodesCount: 10 }]
  }, over || {}));
}

// --- mock factory ---
function makeMock(options) {
  options = options || {};
  var calls = {
    activityPush: [], listeners: {}, requests: [], clears: 0, noty: [],
    settingsComponents: [], settingsParams: [], paramSelects: []
  };

  var menuList = makeEl('');
  function $(arg) {
    if (typeof arg === 'string' && arg.charAt(0) === '<') return makeEl(arg);
    if (typeof arg === 'string') return { eq: function () { return menuList; }, length: 1 };
    return arg;
  }

  // Canned Kinopoisk responses keyed by URL; override via options.responder.
  function defaultResponder(url) {
    if (url.indexOf('/movie/search') >= 0) {
      return { docs: [kpDoc(), kpSeriesDoc()], total: 2, page: 1, pages: 1, limit: 30 };
    }
    if (/\/v1\.4\/movie\/\d+/.test(url)) {
      // 464963 is the series fixture; any other id answers as the movie fixture.
      if (url.indexOf('/movie/464963') >= 0) return kpSeriesDoc({ persons: [], similarMovies: [], sequelsAndPrequels: [] });
      return kpDoc({
        persons: [
          { id: 797, name: 'Мэттью Макконахи', enName: 'Matthew McConaughey', enProfession: 'actor', description: 'Michael', photo: 'https://kp/p/797' },
          { id: 5, name: 'Гай Ричи', enProfession: 'director', photo: 'https://kp/p/5' }
        ],
        similarMovies: [kpDoc({ id: 526, name: 'Большой куш' })],
        sequelsAndPrequels: [],
        slogan: 'Criminal. Class'
      });
    }
    if (url.indexOf('/v1.4/season') >= 0) {
      return {
        docs: [
          { movieId: 464963, number: 1, name: 'Сезон 1', episodes: [{ number: 1, name: 'Зима близко', airDate: '2011-04-17T00:00:00.000Z', description: 'ep1', still: { url: 'https://kp/still/1' } }] },
          { movieId: 464963, number: 2, name: 'Сезон 2', episodes: [{ number: 1, name: 'Север помнит', airDate: '2012-04-01T00:00:00.000Z', still: { url: 'https://kp/still/2' } }] }
        ],
        total: 2, page: 1, pages: 1
      };
    }
    if (url.indexOf('/v1.4/person/') >= 0) {
      return {
        id: 797, name: 'Мэттью Макконахи', enName: 'Matthew McConaughey', photo: 'https://kp/p/797',
        enProfession: 'actor', birthday: '1969-11-04T00:00:00.000Z',
        movies: [{ id: 1143242, name: 'Джентльмены', rating: 8.6, enProfession: 'actor', description: 'Michael' }]
      };
    }
    return { docs: [kpDoc(), kpSeriesDoc()], total: 2, page: 1, pages: 7, limit: 30 };
  }
  var responder = options.responder || defaultResponder;

  function Reguest() {
    this.timeout = function () {};
    this.silent = function (url, ok, err, post, params) {
      calls.requests.push({ url: url, params: params || {} });
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
    Params: { select: function (name, values, def) { calls.paramSelects.push({ name: name, values: values, def: def }); } },
    SettingsApi: {
      addComponent: function (c) { calls.settingsComponents.push(c); },
      addParam: function (p) { calls.settingsParams.push(p); }
    },
    Api: {
      sources: apiSources,
      img: function (src, size) { return tmdbSource.img(src, size); },
      // Real Lampa: hands out `limit` parts at a time, each part a loader(call).
      partNext: function (parts, limit, partLoaded, partEmpty) {
        var taken = parts.splice(0, limit);
        if (!taken.length) { if (partEmpty) partEmpty(); return; }
        var out = [], left = taken.length;
        taken.forEach(function (loader, i) {
          loader(function (json) {
            out[i] = json;
            if (--left === 0) {
              var real = out.filter(function (j) { return j && j.results && j.results.length; });
              if (real.length) partLoaded(real);
              else if (parts.length) Lampa.Api.partNext(parts, limit, partLoaded, partEmpty);
              else if (partEmpty) partEmpty();
            }
          });
        });
      }
    }
  };

  return { Lampa: Lampa, $: $, calls: calls, store: store, menuList: menuList, kpDoc: kpDoc, kpSeriesDoc: kpSeriesDoc };
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

module.exports = { makeMock: makeMock, loadPlugin: loadPlugin, makeEl: makeEl, kpDoc: kpDoc, kpSeriesDoc: kpSeriesDoc };
