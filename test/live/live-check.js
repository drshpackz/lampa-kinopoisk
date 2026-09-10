'use strict';
// Live smoke test: runs the real plugin against the real Kinopoisk API through a
// Node shim of the handful of Lampa APIs the plugin touches.
//
//   node test/live/live-check.js
//
// It is NOT part of `npm test`: it spends real requests from the daily quota
// (about 8) and needs network. Use it after touching the request layer, the row
// queries or the card mapping — a mock cannot tell you a query is malformed.

const https = require('https');
const path = require('path');

const store = {};
const requests = [];

function silent(url, ok, err, post, params) {
  const opts = { headers: (params && params.headers) || {} };
  requests.push(url);
  https.get(url, opts, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) return err({ status: res.statusCode });
      try { ok(JSON.parse(body)); }
      catch (e) { err({ status: 500 }); }
    });
  }).on('error', () => err({ status: -1 }));
}

global.window = { appready: false };
global.$ = function () { return { on() { return this; }, append() { return this; }, eq() { return this; } }; };
global.Lampa = {
  Listener: { follow() {} },
  Activity: { push() {} },
  Noty: { show(m) { console.log('  [noty]', m); } },
  Reguest: function () { this.timeout = () => {}; this.silent = silent; this.clear = () => {}; },
  Storage: {
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; },
    field: (k) => (k in store ? store[k] : 'undefined')
  },
  Params: { select() {} },
  SettingsApi: { addComponent() {}, addParam() {} },
  Api: {
    sources: { tmdb: { img: (s) => s } },
    partNext(parts, limit, partLoaded, partEmpty) {
      const taken = parts.splice(0, limit);
      if (!taken.length) return partEmpty && partEmpty();
      const out = [];
      let left = taken.length;
      taken.forEach((loader, i) => loader((json) => {
        out[i] = json;
        if (--left === 0) {
          const real = out.filter((j) => j && j.results && j.results.length);
          if (real.length) partLoaded(real);
          else if (parts.length) global.Lampa.Api.partNext(parts, limit, partLoaded, partEmpty);
          else partEmpty && partEmpty();
        }
      }));
    }
  }
};

const plugin = require(path.resolve(__dirname, '..', '..', 'kinopoisk.js'));
const { KP, _allRows, _listPath } = plugin;

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

function run(label, fn) {
  return new Promise((resolve) => {
    console.log('\n' + label);
    fn(resolve);
  });
}

(async function main() {
  console.log('Live check against api.poiskkino.dev');
  console.log('Rows defined:', _allRows().length);

  await run('1. main() — first batch of catalog rows', (next) => {
    KP.main({}, (parts) => {
      check('rows returned', parts.length > 0, parts.length + ' rows');
      parts.forEach((p) => {
        check('row "' + p.title + '"', p.results.length > 0, p.results.length + ' cards, ' + p.total_pages + ' pages');
        const bad = p.results.find((c) => !(c.title || c.name) || !c.poster);
        check('  cards complete', !bad, bad ? JSON.stringify(bad).slice(0, 120) : 'title + poster on every card');
        const mixed = p.results.find((c) => c.title && c.original_name);
        check('  movie/series split clean', !mixed, mixed ? 'card has both title and original_name' : 'ok');
      });
      next();
    }, () => { check('main() loaded', false, 'empty'); next(); });
  });

  await run('2. the riskiest row queries actually match documents', (next) => {
    const risky = ['Сейчас в кино', 'Топ 250 Кинопоиска', 'Аниме', 'Боевики'];
    const rows = _allRows().filter((r) => risky.indexOf(r.title) >= 0);
    let left = rows.length;
    rows.forEach((row) => {
      plugin._get('probe', _listPath(row.url, 1), 0, (j) => j, (json) => {
        check('"' + row.title + '"', (json.docs || []).length > 0, (json.total || 0) + ' total');
        if (--left === 0) next();
      }, (e) => {
        check('"' + row.title + '"', false, 'HTTP ' + e.status);
        if (--left === 0) next();
      });
    });
  });

  await run('3. full() on a real movie', (next) => {
    KP.full({ id: 1143242, method: 'movie' }, (data) => {
      check('movie mapped', data.movie.title === 'Джентльмены', data.movie.title);
      check('poster is a usable url', /^https?:\/\//.test(data.movie.poster || ''), data.movie.poster);
      check('rating present', data.movie.vote_average > 0, String(data.movie.vote_average));
      check('imdb id present', !!data.movie.imdb_id, data.movie.imdb_id);
      check('cast populated', data.persons.cast.length > 0, data.persons.cast.length + ' actors');
      check('crew populated', data.persons.crew.length > 0, data.persons.crew.length + ' crew');
      check('similar populated', data.simular.results.length > 0, data.simular.results.length + ' titles');
      next();
    }, () => { check('full() loaded', false); next(); });
  });

  await run('4. full() on a real series, with seasons', (next) => {
    KP.full({ id: 464963, method: 'tv' }, (data) => {
      check('series mapped', !!data.movie.name, data.movie.name);
      check('series routes as tv', !!data.movie.original_name, data.movie.original_name);
      check('seasons counted', data.movie.number_of_seasons > 0, data.movie.number_of_seasons + ' seasons');
      check('episodes block', !!(data.episodes && data.episodes.episodes.length), data.episodes ? 'season ' + data.episodes.season_number + ', ' + data.episodes.episodes.length + ' episodes' : 'missing');
      next();
    }, () => { check('full() loaded', false); next(); });
  });

  await run('5. search()', (next) => {
    KP.search({ query: 'джентльмены' }, (rows) => {
      check('rows returned', rows.length > 0, rows.map((r) => r.title + ':' + r.results.length).join(', '));
      next();
    }, () => { check('search() loaded', false); next(); });
  });

  console.log('\nRequests spent: ' + requests.length + '   quota used today (plugin counter): ' + plugin._quotaUsed());
  console.log(failures ? '\nFAILURES: ' + failures : '\nAll live checks passed.');
  process.exit(failures ? 1 : 0);
})();
