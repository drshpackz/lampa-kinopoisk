'use strict';
// Browser check: loads a real Lampa build, injects the plugin, and drives it.
//
//   node test/live/browser-check.js [http://127.0.0.1:8901]
//
// A mock proves the plugin's own logic; only a real Lampa proves the contract —
// that Api.sources takes a new key, that component 'main' honours source:'kp',
// and that a Kinopoisk card actually opens. Needs `playwright` on NODE_PATH and
// a served Lampa build. Spends a handful of real API requests.

const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8901';
const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', '..', 'kinopoisk.js'), 'utf8');
const SHOTS = path.resolve(__dirname, 'shots');

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
  // appready fires BEFORE Lampa pushes its own start page. Injecting now would
  // get our activity buried under the one Lampa pushes a moment later — so wait
  // for the app to settle on its start page first, exactly as a real user would.
  await page.waitForFunction(() => {
    try { return !!Lampa.Activity.active(); } catch (e) { return false; }
  });
  await page.waitForTimeout(3000);
  check('Lampa booted', true, 'v' + (await page.evaluate(() => Lampa.Manifest.app_digital + '')) +
    ', start page ' + (await page.evaluate(() => Lampa.Activity.active().source + '/' + Lampa.Activity.active().component)));

  console.log('\n1. plugin installs into the running app');
  await page.evaluate(PLUGIN);
  const installed = await page.evaluate(() => ({
    source: !!(Lampa.Api.sources.kp && Lampa.Api.sources.kp.SOURCE_NAME === 'kp'),
    tmdbAlive: !!Lampa.Api.sources.tmdb,
    menu: $('.menu__item[data-action="kinopoisk"]').length,
    inDiscovery: Lampa.Api.availableDiscovery().some((d) => d.title === 'Кинопоиск')
  }));
  check('source registered as kp', installed.source);
  check('built-in tmdb source untouched', installed.tmdbAlive);
  check('menu item added', installed.menu === 1, installed.menu + ' item(s)');
  check('appears in global search', installed.inDiscovery);

  console.log('\n2. the catalog opens and renders Kinopoisk cards');
  await page.evaluate(() => $('.menu__item[data-action="kinopoisk"]').trigger('hover:enter'));
  // Wait for the kp activity itself — the TMDB main page is already on screen
  // with cards of its own, so "cards exist" proves nothing here.
  await page.waitForFunction(
    () => Lampa.Activity.active().source === 'kp' &&
      Lampa.Activity.active().activity.render().find('.card').length > 0
  ).catch(() => {});

  const feed = await page.evaluate(() => {
    const root = Lampa.Activity.active().activity.render()[0];
    const rows = Array.from(root.querySelectorAll('.items-line')).map((l) => ({
      title: ((l.querySelector('.items-line__title') || {}).textContent || '').trim(),
      cards: l.querySelectorAll('.card').length
    }));
    const img = root.querySelector('.card__img');
    return {
      activity: Lampa.Activity.active().source + '/' + Lampa.Activity.active().component,
      rows: rows,
      cards: root.querySelectorAll('.card').length,
      firstPoster: img ? img.getAttribute('src') : ''
    };
  });
  check('activity runs on the kp source', feed.activity === 'kp/main', feed.activity);
  check('rows rendered', feed.rows.length > 0, feed.rows.map((r) => r.title + ':' + r.cards).join(' | '));
  check('cards rendered', feed.cards > 0, feed.cards + ' cards');
  check('posters point at Kinopoisk, not TMDB',
    /avatars\.mds\.yandex\.net|kinopoisk/.test(feed.firstPoster),
    feed.firstPoster.slice(0, 80));
  await page.waitForTimeout(3000); // let the posters finish fading in
  await page.screenshot({ path: path.join(SHOTS, '1-catalog.png') });

  console.log('\n3. a card opens its full page');
  // A card is activated through Lampa's own navigation, not a jQuery trigger:
  // the Card module does not bind 'hover:enter' on the element the way a menu
  // item does. Pressing Enter on the focused card is the real remote path.
  const focused = await page.evaluate(() =>
    !!Lampa.Activity.active().activity.render().find('.card.focus').length);
  check('a card has focus', focused);
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => Lampa.Activity.active().component === 'full' &&
      Lampa.Activity.active().source === 'kp' &&
      !!Lampa.Activity.active().activity.render().find('.full-start-new__title, .full-start__title').length
  ).catch(() => {});

  const full = await page.evaluate(() => {
    const act = Lampa.Activity.active();
    const root = act.activity.render()[0];
    const t = root.querySelector('.full-start-new__title') || root.querySelector('.full-start__title');
    const posterEl = root.querySelector('.full-start__poster img, .full-start-new__poster img');
    const backEl = root.querySelector('.full-start__background');
    return {
      component: act.component,
      source: act.source,
      method: act.method,
      id: act.id,
      title: t ? t.textContent.trim() : '',
      poster: posterEl ? posterEl.getAttribute('src') : '',
      background: backEl ? backEl.getAttribute('src') : '',
      persons: root.querySelectorAll('.full-descr__person, .card--person, .person').length,
      rating: (root.querySelector('.full-start-new__rate-line') || {}).textContent || '',
      badges: Array.from(root.querySelectorAll('.full-start__rate'))
        .filter((b) => !b.classList.contains('hide'))
        .map((b) => b.textContent.replace(/\s+/g, ' ').trim())
    };
  });
  check('full page on the kp source', full.component === 'full' && full.source === 'kp', full.source + '/' + full.component);
  check('routed as a movie with a Kinopoisk id', full.method === 'movie' && full.id > 0, full.method + ' #' + full.id);
  check('title rendered', !!full.title, full.title);
  // Kinopoisk itself serves some artwork from image.tmdb.org, so the host alone
  // proves nothing. What must hold is that the URL came from a Kinopoisk field
  // verbatim and was NOT built by Lampa's TMDB image helper (its mirror host
  // plus the ?email= it appends).
  const built = (u) => /imagetmdb\.com/.test(u || '') || /\?email=/.test(u || '');
  check('poster is a Kinopoisk value, not a Lampa-built TMDB url',
    !!full.poster && !built(full.poster), (full.poster || '(none)').slice(0, 80));
  check('background is a Kinopoisk value too',
    !built(full.background), (full.background || '(none)').slice(0, 80));
  check('rating rendered', /\d/.test(full.rating), full.badges.join('  |  '));
  // vote_average already renders under the source label "KP"; a kp_rating field
  // would print the same number a second time.
  check('the Kinopoisk rating is shown once',
    full.badges.filter((b) => /KP$/i.test(b)).length === 1,
    full.badges.join('  |  '));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS, '2-full.png') });

  console.log('\n4. no unexpected errors on the console');
  // Lampa on a bare localhost always complains about the account/cub endpoints.
  // A bare localhost Lampa always 404s/500s on its own account, cub and
  // extension endpoints; only a poiskkino or plugin-thrown error is ours.
  const ours = errors.filter((e) => /poiskkino/i.test(e) || /^pageerror/.test(e));
  check('no plugin-side errors', ours.length === 0, ours.slice(0, 4).join(' // ') || 'clean');

  console.log('\nScreenshots: ' + SHOTS);
  console.log(failures ? '\nFAILURES: ' + failures : '\nAll browser checks passed.');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
