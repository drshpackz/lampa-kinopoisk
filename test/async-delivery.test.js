'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

// ---------------------------------------------------------------------------
// A user saw the Watch button once and never again. The first open of a card
// came over the network — asynchronously. Every later open came from the
// plugin's cache, and the callback fired synchronously, inside Lampa's own
// call, before the full card finished building. Third-party plugins that add
// the source buttons the Watch button collects missed that window, so the
// button stayed hidden.
//
// Rule: whatever the source of the answer — network, cache, stale copy or a
// quota refusal — the callback never runs before the call that asked for it
// has returned.
// ---------------------------------------------------------------------------

function film(plugin) {
  return (p) => ({ path: p.fullPath(993591), parse: p.parseFull });
}

test('a cache hit is delivered asynchronously', async () => {
  const mock = makeMock();
  const plugin = loadPlugin(mock);

  await new Promise((r) => plugin._get('full', '993591', 600, film(plugin), r, r)); // warm the cache
  assert.ok(plugin._cacheGet('full|993591'), 'precondition: the entry is cached');

  let called = false;
  const done = new Promise((resolve) => {
    plugin._get('full', '993591', 600, film(plugin), () => { called = true; resolve(); }, resolve);
    assert.strictEqual(called, false, 'the cache hit must not call back before _get returns');
  });
  await done;
  assert.strictEqual(called, true);
});

test('full() served from cache does not call Lampa back synchronously', async () => {
  const mock = makeMock();
  const { KP } = loadPlugin(mock);

  await new Promise((resolve, reject) => KP.full({ id: 1143242 }, resolve, reject)); // warm

  let sync = true;
  const p = new Promise((resolve, reject) => KP.full({ id: 1143242 }, (d) => resolve({ d, sync }), reject));
  sync = false;
  const { d, sync: wasSync } = await p;

  assert.strictEqual(wasSync, false, 'Lampa must get the card after its own call has returned');
  assert.strictEqual(d.movie.title, 'Джентльмены');
});

test('a stale copy served when the budget is gone is delivered asynchronously too', async () => {
  const mock = makeMock({ storage: { kp_limit_kpdev: 1 } });
  const plugin = loadPlugin(mock);

  await new Promise((r) => plugin._get('full', '993591', 0, film(plugin), r, r)); // spends the budget, entry expires at once

  let called = false;
  const p = new Promise((resolve) => {
    plugin._get('full', '993591', 0, film(plugin), () => { called = true; resolve('ok'); }, () => resolve('fail'));
    assert.strictEqual(called, false);
  });
  assert.strictEqual(await p, 'ok', 'the stale copy is still served');
});

test('a refusal with nothing cached is delivered asynchronously', async () => {
  const mock = makeMock({ storage: { kp_limit_kpdev: 1 } });
  const plugin = loadPlugin(mock);
  await new Promise((r) => plugin._get('full', 'spent', 60, film(plugin), r, r));

  let called = false;
  const p = new Promise((resolve) => {
    plugin._get('full', 'fresh', 60, film(plugin), () => resolve('ok'), (e) => { called = true; resolve(e); });
    assert.strictEqual(called, false, 'even a refusal must not call back synchronously');
  });
  const err = await p;
  assert.strictEqual(err.quota, true);
});
