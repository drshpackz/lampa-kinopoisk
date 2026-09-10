'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeMock, loadPlugin } = require('./helpers/lampa-mock');

const DEFAULT_TOKEN = 'WC22CBY-RFA4RS0-Q79XE2S-04DR4DH';

function identity(json) { return json; }

test('every request carries the X-API-KEY header with the built-in token', async () => {
  const mock = makeMock();
  const { _get } = loadPlugin(mock);

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 60, identity, done, done));

  assert.strictEqual(mock.calls.requests.length, 1);
  const req = mock.calls.requests[0];
  assert.strictEqual(req.url, 'https://api.poiskkino.dev/v1.4/movie?a=1');
  assert.strictEqual(req.params.headers['X-API-KEY'], DEFAULT_TOKEN);
});

test("the user's own token from settings replaces the built-in one", async () => {
  const mock = makeMock({ storage: { kp_token: '  MY-OWN-TOKEN  ' } });
  const { _get } = loadPlugin(mock);

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 60, identity, done, done));

  assert.strictEqual(mock.calls.requests[0].params.headers['X-API-KEY'], 'MY-OWN-TOKEN');
});

test("Lampa's 'undefined' string for an unset field does not become the token", () => {
  const mock = makeMock({ storage: { kp_token: 'undefined' } });
  const { _token } = loadPlugin(mock);
  assert.strictEqual(_token(), DEFAULT_TOKEN);
});

test('a repeated request is served from cache and costs no network call and no quota', async () => {
  const mock = makeMock();
  const { _get, _quotaUsed } = loadPlugin(mock);

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 60, identity, done, done));
  assert.strictEqual(mock.calls.requests.length, 1);
  assert.strictEqual(_quotaUsed(), 1);

  const second = await new Promise((done) => _get('row', 'v1.4/movie?a=1', 60, identity, done, done));
  assert.strictEqual(mock.calls.requests.length, 1, 'second identical request must not hit the network');
  assert.strictEqual(_quotaUsed(), 1, 'a cache hit must not spend quota');
  assert.ok(second.docs.length);
});

test('an expired entry is refetched', async () => {
  const mock = makeMock();
  const { _get } = loadPlugin(mock);

  // life 0 minutes → the entry is already stale when it is written
  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 0, identity, done, done));
  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 0, identity, done, done));

  assert.strictEqual(mock.calls.requests.length, 2);
});

test('the cache is passed to Lampa too, so a failed request can fall back to its stored copy', async () => {
  const mock = makeMock();
  const { _get } = loadPlugin(mock);

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 720, identity, done, done));

  assert.deepStrictEqual(mock.calls.requests[0].params.cache, { life: 720 });
});

test('when the daily quota is spent the network is not touched and the stale copy is served', async () => {
  const mock = makeMock({ storage: { kp_quota_limit: 1 } });
  const { _get, _quotaLeft } = loadPlugin(mock);

  const first = await new Promise((done) => _get('row', 'v1.4/movie?a=1', 0, identity, done, done));
  assert.ok(first.docs.length);
  assert.strictEqual(_quotaLeft(), 0);

  // Same path, entry expired (life 0) — normally a refetch, but the budget is gone.
  const second = await new Promise((done) => _get('row', 'v1.4/movie?a=1', 0, identity, done, done));

  assert.strictEqual(mock.calls.requests.length, 1, 'no request may be made past the quota');
  assert.ok(second.docs.length, 'the stale copy is served instead of an error');
  assert.ok(mock.calls.noty.some((m) => m.indexOf('лимит') >= 0), 'the user is told once');
});

test('past the quota with nothing cached, the error carries the quota flag', async () => {
  const mock = makeMock({ storage: { kp_quota_limit: 1 } });
  const { _get } = loadPlugin(mock);

  // Spend the single allowed request on another path, so the one under test
  // has neither budget nor a cached copy to fall back to.
  await new Promise((done) => _get('row', 'v1.4/movie?spent=1', 60, identity, done, done));
  const err = await new Promise((resolve) => _get('row', 'v1.4/movie?fresh=1', 60, identity, () => resolve(null), resolve));

  assert.ok(err, 'must fail rather than call done with nothing');
  assert.strictEqual(err.quota, true);
  assert.strictEqual(mock.calls.requests.length, 1, 'only the first, budgeted request may reach the network');
});

test('an HTTP error falls back to the stale copy rather than an empty screen', async () => {
  let fail = false;
  const mock = makeMock({
    responder: (url) => (fail ? { __error: 500 } : { docs: [{ id: 1, name: 'ok' }], page: 1, pages: 1 })
  });
  const { _get } = loadPlugin(mock);

  await new Promise((done) => _get('row', 'v1.4/movie?a=1', 0, identity, done, done));
  fail = true;
  const second = await new Promise((resolve) => _get('row', 'v1.4/movie?a=1', 0, identity, resolve, () => resolve(null)));

  assert.ok(second, 'the stale copy must be served on error');
  assert.strictEqual(second.docs[0].name, 'ok');
});

test('a 401 tells the user the token was rejected', async () => {
  const mock = makeMock({ responder: () => ({ __error: 401 }) });
  const { _get } = loadPlugin(mock);

  await new Promise((resolve) => _get('row', 'v1.4/movie?a=1', 60, identity, resolve, resolve));

  assert.ok(mock.calls.noty.some((m) => m.indexOf('токен') >= 0), 'expected a token warning, got: ' + JSON.stringify(mock.calls.noty));
});

test('an unparsable response fails instead of caching garbage', async () => {
  const mock = makeMock({ responder: () => ({ docs: null }) });
  const { _get } = loadPlugin(mock);

  const err = await new Promise((resolve) => _get('row', 'v1.4/movie?a=1', 60, () => { throw new Error('bad'); }, () => resolve(null), resolve));

  assert.ok(err);
  assert.strictEqual(err.parse, true);
});
