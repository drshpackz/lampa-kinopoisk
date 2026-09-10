'use strict';
// Browser check: loads a real Lampa build, injects the plugin, and drives it.
//
//   node test/live/browser-check.js [http://127.0.0.1:8901]
//
// A mock proves the plugin's own logic; only a real Lampa proves the contract —
// that Api.sources takes a new key, that the Kinopoisk tab appears in the global
// search, and that a Kinopoisk card actually opens. Needs `playwright` on
// NODE_PATH and a served Lampa build:
//
//   git clone --depth=1 https://github.com/yumata/lampa /tmp/lampa
//   python3 -m http.server 8901 --directory /tmp/lampa &
//
// Spends a handful of real API requests.

const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8901';
const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', '..', 'kinopoisk.js'), 'utf8');
const SHOTS = path.resolve(__dirname, 'shots');
const QUERY = process.env.KP_QUERY || 'завод';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

(async function main() {
  const { chromium } = require('playwright');
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.setDefaultTimeout(90000);

  console.log('Loading Lampa from ' + BASE);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });

  // A fresh profile opens on the language picker; one click gets past it.
  await page.waitForTimeout(6000);
  if (!(await page.evaluate(() => window.appready))) {
    await page.evaluate(() => {
      const sels = Array.from(document.querySelectorAll('.selector')).filter((e) => e.offsetParent !== null);
      const ru = sels.find((e) => /Русский/.test(e.innerText)) || sels[0];
      if (ru) { ru.click(); if (window.$) $(ru).trigger('hover:enter'); }
    });
  }
  await page.waitForFunction('window.appready === true');
  // appready fires BEFORE Lampa pushes its own start page; injecting now would
  // get our work buried under the activity Lampa pushes a moment later.
  await page.waitForFunction(() => { try { return !!Lampa.Activity.active(); } catch (e) { return false; } });
  await page.waitForTimeout(3000);
  check('Lampa booted', true, 'v' + (await page.evaluate(() => Lampa.Manifest.app_digital + '')));

  console.log('\n1. plugin installs into the running app');
  // Tokens live in Lampa.Storage, exactly where the settings screen puts them.
  if (process.env.KPU_TOKEN || process.env.KP_TOKEN) {
    await page.evaluate((t) => {
      if (t.kpu) Lampa.Storage.set('kp_token_unofficial', t.kpu);
      if (t.dev) Lampa.Storage.set('kp_token', t.dev);
    }, { kpu: process.env.KPU_TOKEN || '', dev: process.env.KP_TOKEN || '' });
  }
  await page.evaluate(PLUGIN);
  const installed = await page.evaluate(() => ({
    source: !!(Lampa.Api.sources.kp && Lampa.Api.sources.kp.SOURCE_NAME === 'kp'),
    tmdbAlive: !!Lampa.Api.sources.tmdb,
    menu: $('.menu__item[data-action="kinopoisk"]').length,
    inDiscovery: Lampa.Api.availableDiscovery().some((d) => d.title === 'Кинопоиск'),
    activeSource: Lampa.Storage.get('source', 'tmdb')
  }));
  check('source registered as kp', installed.source);
  check('built-in tmdb source untouched', installed.tmdbAlive);
  check('the Kinopoisk tab is in the global search', installed.inDiscovery);
  check('no menu item — this plugin lives in search only', installed.menu === 0, installed.menu + ' item(s)');
  check('the app-wide source is not hijacked', installed.activeSource !== 'kp', installed.activeSource);

  console.log('\n2. search returns Kinopoisk cards');
  const found = await page.evaluate((query) => new Promise((resolve) => {
    let done = false;
    Lampa.Api.sources.kp.search({ query: query }, (rows) => {
      if (done) return;
      done = true;
      resolve({ ok: true, rows: rows.map((r) => r.title + ':' + r.results.length), first: rows[0] && rows[0].results[0] });
    }, () => { if (!done) { done = true; resolve({ ok: false }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, timeout: true }); } }, 30000);
  }), QUERY);

  check('search succeeded', found.ok,
    found.ok ? found.rows.join(', ') : (found.timeout ? 'timed out' : 'all providers refused (quota or token)'));
  if (found.ok && found.first) {
    check('poster is a Kinopoisk url', /^https?:\/\//.test(found.first.poster || ''), (found.first.poster || '').slice(0, 70));
    check('card carries the Kinopoisk id', !!found.first.kinopoisk_id, String(found.first.kinopoisk_id));
  }

  if (!found.ok || !found.first) {
    console.log('\nSkipping the card check — nothing was found to open.');
  } else {
    console.log('\n3. a found card opens its full page');
    await page.evaluate((card) => Lampa.Activity.push({
      url: '', component: 'full', source: 'kp',
      id: card.id, method: card.original_name ? 'tv' : 'movie', card: card, page: 1
    }), found.first);

    // The title element exists in the template before the data lands, so
    // waiting for the element alone measures an empty page. Wait for text.
    const rendered = await page.waitForFunction(() => {
      const act = Lampa.Activity.active();
      if (act.component !== 'full' || act.source !== 'kp') return false;
      const t = act.activity.render().find('.full-start-new__title, .full-start__title');
      return !!(t.length && t.text().trim());
    }, null, { timeout: 45000 }).then(() => true).catch(() => false);
    check('card finished loading', rendered, rendered ? 'title rendered' : 'still loading after 45s');

    const full = await page.evaluate(() => {
      const act = Lampa.Activity.active();
      const root = act.activity.render()[0];
      const t = root.querySelector('.full-start-new__title') || root.querySelector('.full-start__title');
      const poster = root.querySelector('.full-start__poster img, .full-start-new__poster img');
      return {
        component: act.component,
        source: act.source,
        title: t ? t.textContent.trim() : '',
        poster: poster ? poster.getAttribute('src') : '',
        badges: Array.from(root.querySelectorAll('.full-start__rate'))
          .filter((b) => !b.classList.contains('hide'))
          .map((b) => b.textContent.replace(/\s+/g, ' ').trim())
      };
    });

    // Kinopoisk itself serves some artwork from image.tmdb.org, so the host
    // proves nothing; what matters is that Lampa did not build the URL.
    const built = (u) => /imagetmdb\.com/.test(u || '') || /\?email=/.test(u || '');
    check('full page on the kp source', full.component === 'full' && full.source === 'kp', full.source + '/' + full.component);
    check('title rendered', !!full.title, full.title);
    check('poster is a Kinopoisk value, not a Lampa-built TMDB url', !!full.poster && !built(full.poster), (full.poster || '(none)').slice(0, 70));
    check('the Kinopoisk rating is shown once', full.badges.filter((b) => /KP$/i.test(b)).length <= 1, full.badges.join('  |  '));

    await page.waitForTimeout(3000);
    // The src attribute only proves we handed Lampa the right URL. What matters
    // to a viewer is whether the image painted.
    const painted = await page.evaluate(() => {
      const img = Lampa.Activity.active().activity.render()[0]
        .querySelector('.full-start__poster img, .full-start-new__poster img');
      return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    });
    check('the poster actually painted', !!(painted && painted.w > 0),
      painted ? (painted.w + '×' + painted.h) : 'no image element');

    await page.screenshot({ path: path.join(SHOTS, 'card.png') });
  }

  console.log('\n4. no plugin-side errors');
  // A bare localhost Lampa always 404s/500s on its own account, cub and
  // extension endpoints; only an API or plugin-thrown error is ours.
  // Kinopoisk's image hosts send no Access-Control-Allow-Origin, so Lampa's
  // image machinery logs a CORS complaint even though a plain <img> renders
  // fine (verified above: the poster paints). That noise is not ours; a thrown
  // exception or a failed API call is.
  const ours = errors.filter((e) =>
    (/poiskkino|kinopoiskapiunofficial/i.test(e) && !/blocked by CORS policy/i.test(e)) ||
    /^pageerror/.test(e));
  check('console clean', ours.length === 0, ours.slice(0, 3).join(' // ') || 'clean');

  console.log('\nScreenshots: ' + SHOTS);
  console.log(failures ? '\nFAILURES: ' + failures : '\nAll browser checks passed.');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
