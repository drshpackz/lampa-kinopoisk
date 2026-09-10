'use strict';
// Live check: runs the real plugin against the real APIs through a Node shim of
// the few Lampa APIs it touches.
//
//   node test/live/live-check.js                 # kinopoisk.dev only
//   KPU_TOKEN=<key> node test/live/live-check.js # both providers + failover
//
// Not part of `npm test`: it spends real daily quota (about 6 requests) and
// needs network. Run it after touching the request layer, a provider adapter or
// the card mapping — a mock cannot tell you a path is wrong or a field renamed.

const https = require('https');
const path = require('path');

const store = {};
if (process.env.KP_TOKEN) store.kp_token = process.env.KP_TOKEN;
if (process.env.KPU_TOKEN) store.kp_token_unofficial = process.env.KPU_TOKEN;

const requests = [];

function silent(url, ok, err, post, params) {
  requests.push(url);
  https.get(url, { headers: (params && params.headers) || {} }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) return err({ status: res.statusCode });
      try { ok(JSON.parse(body)); } catch (e) { err({ status: 500 }); }
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
  Api: { sources: { tmdb: { img: (s) => s } }, partNext() {} }
};

const plugin = require(path.resolve(__dirname, '..', '..', 'kinopoisk.js'));
const { KP } = plugin;

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}
function run(label, fn) {
  return new Promise((resolve) => { console.log('\n' + label); fn(resolve); });
}

(async function main() {
  console.log('Live check');
  plugin.PROVIDERS.forEach((p) => {
    console.log('  ' + p.name.padEnd(6) + ' ' + p.title.padEnd(32) +
      (plugin._tokenOf(p) ? ('budget ' + plugin._quotaLeft(p) + '/' + plugin._limitOf(p)) : 'no token — skipped'));
  });
  if (!plugin._availableProviders().length) {
    console.log('\nNo provider has budget today. Set KPU_TOKEN=<key> to exercise the second one.');
  }

  let firstCard = null;

  await run('1. search', (next) => {
    KP.search({ query: 'завод' }, (rows) => {
      check('rows returned', rows.length > 0, rows.map((r) => r.title + ':' + r.results.length).join(', '));
      rows.forEach((row) => {
        const bad = row.results.find((c) => !(c.title || c.name) || !c.poster);
        check('  "' + row.title + '" cards complete', !bad, bad ? JSON.stringify(bad).slice(0, 110) : 'title + poster on every card');
        const mixed = row.results.find((c) => c.title && c.original_name);
        check('  "' + row.title + '" movie/series split clean', !mixed, mixed ? 'card has both title and original_name' : 'ok');
      });
      firstCard = rows[0] && rows[0].results[0];
      next();
    }, () => { check('search loaded', false, 'all providers refused'); next(); });
  });

  await run('2. the "more" grid pages', (next) => {
    KP.list({ query: encodeURIComponent('завод'), page: 2 }, (page) => {
      check('page 2 returned', page.results.length > 0, page.results.length + ' cards of ' + page.total_pages + ' pages');
      next();
    }, () => { check('list loaded', false); next(); });
  });

  await run('3. full() on a real movie', (next) => {
    KP.full({ id: 1143242, method: 'movie' }, (data) => {
      check('movie mapped', !!data.movie.title, data.movie.title);
      check('poster is a usable url', /^https?:\/\//.test(data.movie.poster || ''), (data.movie.poster || '').slice(0, 70));
      check('rating present', data.movie.vote_average > 0, String(data.movie.vote_average));
      check('genres present', (data.movie.genres || []).length > 0, (data.movie.genres || []).map((g) => g.name).join(', '));
      next();
    }, () => { check('full loaded', false); next(); });
  });

  await run('4. full() on a real series, with seasons', (next) => {
    KP.full({ id: 464963, method: 'tv' }, (data) => {
      check('series routes as tv', !!data.movie.original_name, data.movie.original_name);
      check('seasons counted', data.movie.number_of_seasons > 0, data.movie.number_of_seasons + ' seasons');
      check('episodes block', !!(data.episodes && data.episodes.episodes.length),
        data.episodes ? ('season ' + data.episodes.season_number + ', ' + data.episodes.episodes.length + ' episodes') : 'missing');
      next();
    }, () => { check('full loaded', false); next(); });
  });

  console.log('\nRequests spent: ' + requests.length);
  plugin.PROVIDERS.forEach((p) => {
    if (plugin._tokenOf(p)) console.log('  ' + p.name + ': ' + plugin._quotaUsed(p) + ' used');
  });
  console.log(failures ? '\nFAILURES: ' + failures : '\nAll live checks passed.');
  process.exit(failures ? 1 : 0);
})();
