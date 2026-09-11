'use strict';
// ===========================================================================
// Кеширующий сервер-посредник для плагина «Кинопоиск» в Lampa.
//
// Зачем. Бесплатного безлимитного источника данных Кинопоиска нет: оба API
// дают сотни запросов в СУТКИ на ключ, а сам kinopoisk.ru закрыт стеной
// авторизации Яндекса. Лимит нельзя отменить, но можно сделать так, чтобы он
// перестал заканчиваться:
//
//   * ключи хранятся здесь, на сервере, а не в каждом телевизоре;
//   * каждый ответ кешируется на диск надолго, и кеш общий для всех устройств.
//     Запрос к Кинопоиску тратится только на тайтл, который ещё никто не
//     открывал; все повторные открытия — бесплатно;
//   * ключей у провайдера может быть несколько: исчерпанный (403) или
//     отвергнутый (401) выключается до конца суток, запрос идёт со следующим.
//
// Протокол для плагина — те же пути, что у самих API, с префиксом провайдера:
//
//   GET /kpdev/v1.4/movie/search?query=...   -> https://api.poiskkino.dev/...
//   GET /kpu/api/v2.2/films/993591           -> https://kinopoiskapiunofficial.tech/...
//
// Пропускаются только пути, которые нужны плагину, — открытым прокси к чужим
// API этот сервер не станет. Ключи не покидают сервер (/health показывает
// только их количество).
//
// Запуск:
//   KPDEV_TOKENS=key1,key2 KPU_TOKENS=key3 node server/kp-proxy.js
//   PORT=8787 HOST=127.0.0.1 CACHE_DIR=/var/cache/kp-proxy — по желанию
//
// Без зависимостей: только встроенные модули Node 18+ (нужен глобальный fetch).
// ===========================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Какие пути разрешены у каждого провайдера. Всё прочее — 404.
const UPSTREAMS = {
  kpdev: {
    base: 'https://api.poiskkino.dev/',
    allow: [
      /^v1\.4\/movie\/search\?/,     // поиск
      /^v1\.4\/movie\/\d+$/,         // карточка
      /^v1\.4\/season\?movieId=\d+/  // сезоны
    ]
  },
  kpu: {
    base: 'https://kinopoiskapiunofficial.tech/',
    allow: [
      /^api\/v2\.1\/films\/search-by-keyword\?/,
      /^api\/v2\.2\/films\/\d+$/,
      /^api\/v2\.2\/films\/\d+\/seasons$/
    ]
  }
};

// Сколько живёт ответ. Карточка тайтла почти не меняется; поиск — меняется,
// когда выходят новинки, поэтому он живёт сутки.
function ttlFor(upath) {
  if (/search/.test(upath)) return DAY;
  if (/season/.test(upath)) return 7 * DAY;
  return 30 * DAY;
}

function splitTokens(s) {
  return String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function utcDay(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

/**
 * @param {object} opts
 * @param {{kpdev?: string[], kpu?: string[]}} opts.tokens
 * @param {string} [opts.cacheDir]   куда класть кеш (без него — только память)
 * @param {function} [opts.fetch]    для тестов; по умолчанию глобальный fetch
 * @param {function} [opts.now]      для тестов; по умолчанию Date.now
 * @param {number} [opts.memLimit]   записей в памяти
 */
function createServer(opts) {
  opts = opts || {};
  const tokens = { kpdev: (opts.tokens && opts.tokens.kpdev) || [], kpu: (opts.tokens && opts.tokens.kpu) || [] };
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const cacheDir = opts.cacheDir || null;
  const memLimit = opts.memLimit || 2000;

  const memory = new Map();   // key -> {until, body}
  const inflight = new Map(); // key -> Promise — два телевизора, одна карточка, один запрос
  const dead = new Map();     // provider|token -> utcDay
  const stats = { requests: 0, hits: 0, misses: 0, stale: 0, upstream: 0 };

  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  // ------------------------------- кеш -------------------------------------

  function cacheKey(provider, upath) {
    return crypto.createHash('sha1').update(provider + '|' + upath).digest('hex');
  }

  function cacheRead(key) {
    if (memory.has(key)) return memory.get(key);
    if (!cacheDir) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, key + '.json'), 'utf8'));
      remember(key, entry);
      return entry;
    } catch (e) {
      return null;
    }
  }

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    if (memory.size > memLimit) memory.delete(memory.keys().next().value);
  }

  function cacheWrite(key, body, ttl) {
    const entry = { until: now() + ttl, at: now(), body: body };
    remember(key, entry);
    if (cacheDir) {
      // через временный файл, чтобы прерванная запись не оставила битый JSON
      const file = path.join(cacheDir, key + '.json');
      const tmp = file + '.' + process.pid + '.tmp';
      try { fs.writeFileSync(tmp, JSON.stringify(entry)); fs.renameSync(tmp, file); } catch (e) { /* диск полон — живём памятью */ }
    }
  }

  // ------------------------------- ключи -----------------------------------

  function liveTokens(provider) {
    const today = utcDay(now());
    return tokens[provider].filter((t) => dead.get(provider + '|' + t) !== today);
  }

  function markDead(provider, token) {
    dead.set(provider + '|' + token, utcDay(now()));
  }

  // ------------------------------ апстрим ----------------------------------

  async function fetchWithRotation(provider, upath) {
    const live = liveTokens(provider);
    if (!live.length) {
      return { ok: false, status: 403, body: JSON.stringify({ message: 'kp-proxy: нет рабочих ключей для ' + provider + ' на сегодня' }) };
    }
    let last = null;
    for (const token of live) {
      let res;
      try {
        res = await fetchImpl(UPSTREAMS[provider].base + upath, {
          headers: { 'X-API-KEY': token, accept: 'application/json' }
        });
      } catch (e) {
        last = { ok: false, status: 502, body: JSON.stringify({ message: 'kp-proxy: апстрим недоступен' }) };
        continue;
      }
      stats.upstream++;
      const body = await res.text();
      if (res.status === 200) {
        try { JSON.parse(body); } catch (e) {
          last = { ok: false, status: 502, body: JSON.stringify({ message: 'kp-proxy: апстрим вернул не JSON' }) };
          continue;
        }
        return { ok: true, status: 200, body: body };
      }
      // 401 — ключ неверный, 403 — суточный лимит ключа. В обоих случаях этот
      // ключ сегодня бесполезен; пробуем следующий.
      if (res.status === 401 || res.status === 403) {
        markDead(provider, token);
        last = { ok: false, status: res.status, body: body };
        continue;
      }
      // 404 и прочее — ответ о самих данных, другой ключ его не изменит.
      return { ok: false, status: res.status, body: body };
    }
    return last;
  }

  // ------------------------------- HTTP ------------------------------------

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }

  function send(res, status, body, cacheState) {
    if (cacheState) res.setHeader('X-KP-Cache', cacheState);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function allowed(provider, upath) {
    return UPSTREAMS[provider].allow.some((re) => re.test(upath));
  }

  function health() {
    return {
      ok: true,
      tokens: {
        kpdev: { total: tokens.kpdev.length, live: liveTokens('kpdev').length },
        kpu: { total: tokens.kpu.length, live: liveTokens('kpu').length }
      },
      cache: { memory: memory.size, dir: cacheDir ? true : false },
      stats: Object.assign({}, stats)
    };
  }

  async function resolve(provider, upath) {
    const key = cacheKey(provider, upath);
    const entry = cacheRead(key);
    if (entry && entry.until > now()) { stats.hits++; return { status: 200, body: entry.body, state: 'hit' }; }

    if (!inflight.has(key)) {
      inflight.set(key, fetchWithRotation(provider, upath).finally(() => inflight.delete(key)));
    }
    const r = await inflight.get(key);

    if (r.ok) {
      cacheWrite(key, r.body, ttlFor(upath));
      stats.misses++;
      return { status: 200, body: r.body, state: 'miss' };
    }
    // Лимиты кончились или апстрим лежит — вчерашний ответ лучше пустого экрана.
    if (entry) { stats.stale++; return { status: 200, body: entry.body, state: 'stale' }; }
    stats.misses++;
    return { status: r.status || 502, body: r.body, state: 'miss' };
  }

  async function handle(req, res) {
    stats.requests++;
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { send(res, 405, { message: 'только GET' }); return; }

    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/health') { send(res, 200, health()); return; }

    const m = /^\/(kpdev|kpu)\/(.+)$/.exec(u.pathname);
    if (!m) { send(res, 404, { message: 'kp-proxy: неизвестный маршрут' }); return; }
    const provider = m[1];
    const upath = m[2] + u.search;
    if (!allowed(provider, upath)) { send(res, 404, { message: 'kp-proxy: путь не разрешён' }); return; }

    try {
      const r = await resolve(provider, upath);
      send(res, r.status, r.body, r.state);
    } catch (e) {
      send(res, 500, { message: 'kp-proxy: внутренняя ошибка' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.stats = stats;
  server.health = health;
  return server;
}

module.exports = { createServer, ttlFor, UPSTREAMS };

if (require.main === module) {
  const tokens = { kpdev: splitTokens(process.env.KPDEV_TOKENS), kpu: splitTokens(process.env.KPU_TOKENS) };
  const port = parseInt(process.env.PORT, 10) || 8787;
  // По умолчанию слушаем только localhost: наружу сервер выставляется
  // осознанно, через nginx с TLS, а не случайно.
  const host = process.env.HOST || '127.0.0.1';
  const cacheDir = process.env.CACHE_DIR || path.join(__dirname, '.cache');

  if (!tokens.kpdev.length && !tokens.kpu.length) {
    console.error('kp-proxy: не задано ни одного ключа. Укажите KPDEV_TOKENS и/или KPU_TOKENS.');
    process.exit(1);
  }
  createServer({ tokens, cacheDir }).listen(port, host, () => {
    console.log('kp-proxy: http://' + host + ':' + port + '  ключей kpdev=' + tokens.kpdev.length +
      ' kpu=' + tokens.kpu.length + '  кеш=' + cacheDir);
  });
}
