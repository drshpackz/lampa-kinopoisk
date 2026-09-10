(function () {
  'use strict';

  // ===========================================================================
  // Кинопоиск для Lampa — вкладка в поиске
  //
  // Плагин добавляет «Кинопоиск» в общий поиск Lampa и умеет открыть карточку
  // найденного тайтла (с сезонами и сериями). Каталога и пункта меню нет
  // намеренно: лента из 22 рядов стоила два десятка запросов на одно открытие,
  // а бесплатные токены Кинопоиска считаются сотнями запросов в СУТКИ. Поиск —
  // это один запрос, карточка — ещё один. На такой профиль лимитов хватает.
  //
  // Источников данных два, и они взаимозаменяемы, потому что оба ключуются
  // одним и тем же id Кинопоиска:
  //
  //   kinopoisk.dev (api.poiskkino.dev)  — 200 запросов/сутки, данные богаче
  //                                        (актёры и похожие приходят вместе с
  //                                        карточкой, есть imdb и tmdb id)
  //   kinopoiskapiunofficial.tech        — 500 запросов/сутки
  //
  // Если у первого кончился лимит или не принят токен — запрос молча уходит ко
  // второму. В этом и смысл двух провайдеров: у пользователя со своими ключами
  // получается 700 бесплатных запросов в сутки вместо 200.
  // ===========================================================================

  var SOURCE = 'kp';
  var DEFAULT_TOKEN = 'WC22CBY-RFA4RS0-Q79XE2S-04DR4DH';

  // Lampa меряет время жизни кеша в МИНУТАХ (Request: life * 1000 * 60).
  var HOUR = 60;
  var DAY = 60 * 24;
  var LIFE = { search: HOUR * 6, full: DAY * 7, season: DAY * 7 };

  // ===========================================================================
  // Хранилище
  // ===========================================================================

  function storageGet(key, def) {
    return (Lampa.Storage && Lampa.Storage.get) ? Lampa.Storage.get(key, def) : def;
  }
  function storageSet(key, value) {
    if (Lampa.Storage && Lampa.Storage.set) Lampa.Storage.set(key, value);
  }

  // Params.field() отдаёт строку 'undefined' для незарегистрированных ключей,
  // поэтому «пусто» приходится проверять именно так.
  function cleanString(v) {
    v = (v === null || v === undefined) ? '' : String(v).trim();
    return (v === 'undefined') ? '' : v;
  }

  // ===========================================================================
  // Общие конструкторы карточки
  //
  // Оба провайдера обязаны выдать ОДНУ И ТУ ЖЕ карточку Lampa, поэтому всё, что
  // ниже по файлу, о различиях между API не знает.
  // ===========================================================================

  function baseCard(id) {
    return { source: SOURCE, id: id, kinopoisk_id: id };
  }

  /**
   * Разложить названия по полям, от которых зависит роутинг Lampa.
   * router.add('full'): method = data.original_name ? 'tv' : 'movie'. Поэтому у
   * фильма только title/original_title, у сериала только name/original_name —
   * если проставить оба набора, фильм откроется как сериал.
   */
  function applyNames(card, series, ru, orig, year) {
    var date = year ? (year + '-01-01') : '';
    if (series) {
      card.name = ru;
      // Роутинг сериала держится на НЕПУСТОМ original_name, а Кинопоиск
      // регулярно отдаёт оригинальное название пустой строкой у российских
      // тайтлов. Пустое поле открыло бы сериал как фильм — без сезонов.
      card.original_name = orig || ru;
      card.first_air_date = date;
    } else {
      card.title = ru;
      card.original_title = orig || ru;
      card.release_date = date;
    }
    return card;
  }

  function episode(number, season_number, name, overview, air_date, img_url) {
    return {
      id: season_number + '-' + number,
      episode_number: number,
      season_number: season_number,
      name: name || ('Серия ' + number),
      overview: overview || '',
      air_date: (air_date || '').slice(0, 10),
      img: img_url || '',
      still_path: null, // still_path ушёл бы через хост картинок TMDB
      vote_average: 0
    };
  }

  function season(id, number, name, overview, episodes) {
    return {
      id: id,
      season_number: number,
      name: name || ('Сезон ' + number),
      overview: overview || '',
      episodes: episodes,
      source: SOURCE
    };
  }

  // ===========================================================================
  // Провайдер 1: kinopoisk.dev
  // ===========================================================================

  var SERIES_TYPES_DEV = { 'tv-series': 1, 'animated-series': 1, 'tv-show': 1 };

  function devIsSeries(doc) {
    if (doc.isSeries === true) return true;
    if (doc.isSeries === false) return false;
    return !!SERIES_TYPES_DEV[doc.type];
  }

  function devImage(node, big) {
    if (!node) return '';
    return (big ? (node.url || node.previewUrl) : (node.previewUrl || node.url)) || '';
  }

  function devCard(doc) {
    if (!doc || doc.id == null) return null;
    var rating = doc.rating || {}, votes = doc.votes || {};
    var ru = doc.name || doc.alternativeName || doc.enName || '';
    var orig = doc.alternativeName || doc.enName || doc.name || '';
    if (!ru) return null;
    var year = doc.year || (doc.releaseYears && doc.releaseYears[0] && doc.releaseYears[0].start);

    var card = baseCard(doc.id);
    card.overview = doc.description || doc.shortDescription || '';
    // Постеры Кинопоиска — готовые абсолютные URL, поэтому poster_path НЕ
    // заполняется: Api.img() подставил бы к нему хост TMDB.
    card.poster = devImage(doc.poster, false);
    card.img = card.poster;
    card.background_image = devImage(doc.backdrop, true);
    card.vote_average = rating.kp || rating.imdb || rating.tmdb || 0;
    card.vote_count = votes.kp || votes.imdb || 0;
    card.imdb_rating = rating.imdb || 0;
    if (doc.externalId && doc.externalId.imdb) card.imdb_id = doc.externalId.imdb;
    if (doc.ageRating != null) card.pg = doc.ageRating + '+';

    return applyNames(card, devIsSeries(doc), ru, orig, year);
  }

  function devCards(docs) {
    var out = [], i, c;
    docs = docs || [];
    for (i = 0; i < docs.length; i++) { c = devCard(docs[i]); if (c) out.push(c); }
    return out;
  }

  var DEV_PROFESSION_JOB = {
    director: 'Director', writer: 'Writer', producer: 'Producer',
    composer: 'Original Music Composer', operator: 'Director of Photography',
    editor: 'Editor', designer: 'Production Design'
  };

  function devPersons(persons) {
    var cast = [], crew = [], i, p, c;
    persons = persons || [];
    for (i = 0; i < persons.length; i++) {
      p = persons[i];
      if (!p || p.id == null) continue;
      c = {
        id: p.id, name: p.name || p.enName || '', original_name: p.enName || p.name || '',
        img: p.photo || '', poster: p.photo || '', source: SOURCE
      };
      if (p.enProfession === 'actor') { c.character = p.description || ''; cast.push(c); }
      else { c.job = DEV_PROFESSION_JOB[p.enProfession] || p.profession || ''; c.department = p.enProfession || ''; crew.push(c); }
    }
    return { id: 0, cast: cast, crew: crew };
  }

  function devMovie(doc) {
    var card = devCard(doc);
    if (!card) return null;
    var i, genres = doc.genres || [], countries = doc.countries || [];

    card.genres = [];
    for (i = 0; i < genres.length; i++) card.genres.push({ id: genres[i].id || i, name: genres[i].name });
    card.production_countries = [];
    for (i = 0; i < countries.length; i++) card.production_countries.push({ name: countries[i].name });
    card.origin_country = card.production_countries;

    // Lampa читает card.production_companies.length БЕЗ проверки на undefined
    // (модуль описания полной карточки), поэтому массив обязан существовать,
    // даже пустой — иначе карточка навсегда остаётся в состоянии загрузки.
    card.production_companies = [];
    for (i = 0; i < ((doc.networks && doc.networks.items) || []).length; i++) {
      card.production_companies.push({ id: i, name: doc.networks.items[i].name });
    }

    card.tagline = doc.slogan || '';
    card.runtime = doc.movieLength || doc.seriesLength || 0;
    return card;
  }

  // Без selectFields Кинопоиск отдаёт документ целиком — на телевизоре это
  // лишние мегабайты на каждый поиск.
  var DEV_CARD_FIELDS = ['id', 'name', 'alternativeName', 'enName', 'type', 'isSeries', 'year',
    'releaseYears', 'description', 'shortDescription', 'rating', 'votes', 'poster',
    'backdrop', 'genres', 'countries', 'movieLength', 'ageRating', 'externalId'];

  var KPDEV = {
    name: 'kpdev',
    title: 'kinopoisk.dev',
    host: 'https://api.poiskkino.dev/',
    token_key: 'kp_token',
    token_default: DEFAULT_TOKEN,
    limit_key: 'kp_limit_kpdev',
    limit_default: 200,

    searchPath: function (query, page) {
      var fields = [], i;
      for (i = 0; i < DEV_CARD_FIELDS.length; i++) fields.push('selectFields=' + DEV_CARD_FIELDS[i]);
      return 'v1.4/movie/search?query=' + encodeURIComponent(query) +
        '&limit=30&page=' + (page || 1) + '&' + fields.join('&');
    },
    parseSearch: function (json) {
      return {
        results: devCards(json && json.docs),
        page: (json && json.page) || 1,
        total_pages: (json && json.pages) || 1,
        total_results: (json && json.total) || 0
      };
    },

    fullPath: function (id) { return 'v1.4/movie/' + id; },
    parseFull: function (json) {
      if (!json || json.id == null) throw new Error('empty');
      return {
        movie: devMovie(json),
        persons: devPersons(json.persons),
        simular: { results: devCards(json.similarMovies), title: 'Похожие' }
      };
    },

    seasonsPath: function (id) {
      return 'v1.4/season?movieId=' + id + '&limit=50&page=1&sortField=number&sortType=1';
    },
    parseSeasons: function (json) {
      var docs = (json && json.docs) || [], out = {}, i, d, eps, j, list;
      for (i = 0; i < docs.length; i++) {
        d = docs[i];
        if (d.number == null) continue;
        eps = d.episodes || [];
        list = [];
        for (j = 0; j < eps.length; j++) {
          list.push(episode(eps[j].number, d.number, eps[j].name || eps[j].enName,
            eps[j].description || eps[j].enDescription, eps[j].airDate, devImage(eps[j].still, true)));
        }
        out[d.number] = season((d.movieId || 0) + '-' + d.number, d.number, d.name, d.description, list);
      }
      return out;
    }
  };

  // ===========================================================================
  // Провайдер 2: kinopoiskapiunofficial.tech
  //
  // Пути и имена полей сверены с рабочим клиентом: поиск живёт на v2.1,
  // карточка и сезоны — на v2.2. Названия полей другие, но id тайтла — тот же
  // самый id Кинопоиска, поэтому карточку, найденную здесь, можно открыть там.
  // ===========================================================================

  var SERIES_TYPES_UNOFFICIAL = { 'TV_SERIES': 1, 'MINI_SERIES': 1, 'TV_SHOW': 1 };

  function unofficialIsSeries(doc) {
    if (doc.serial === true) return true;
    return !!SERIES_TYPES_UNOFFICIAL[doc.type];
  }

  // В поиске id называется filmId, в карточке — kinopoiskId.
  function unofficialId(doc) {
    var id = (doc.kinopoiskId != null) ? doc.kinopoiskId : doc.filmId;
    return (id == null) ? null : id;
  }

  // Жанры приходят как [{genre:'драма'}], страны как [{country:'США'}].
  // Читаем и через name — на случай, если поле переименуют.
  function unofficialList(arr, key) {
    var out = [], i, v;
    arr = arr || [];
    for (i = 0; i < arr.length; i++) {
      v = arr[i] && (arr[i][key] || arr[i].name);
      if (v) out.push(v);
    }
    return out;
  }

  function unofficialCard(doc) {
    if (!doc) return null;
    var id = unofficialId(doc);
    if (id == null) return null;

    // Пустые строки и null здесь обычное дело, поэтому порядок важен.
    var ru = doc.nameRu || doc.nameEn || doc.nameOriginal || '';
    var orig = doc.nameOriginal || doc.nameEn || doc.nameRu || '';
    var year = parseInt(doc.year, 10) || 0;
    if (!ru) return null;

    var card = baseCard(id);
    card.overview = doc.description || doc.shortDescription || '';
    card.poster = doc.posterUrlPreview || doc.posterUrl || '';
    card.img = card.poster;
    card.background_image = doc.coverUrl || doc.posterUrl || '';
    card.vote_average = parseFloat(doc.ratingKinopoisk || doc.rating || doc.ratingImdb) || 0;
    card.vote_count = parseInt(doc.ratingKinopoiskVoteCount || doc.ratingVoteCount, 10) || 0;
    card.imdb_rating = parseFloat(doc.ratingImdb) || 0;
    if (doc.imdbId) card.imdb_id = doc.imdbId;

    return applyNames(card, unofficialIsSeries(doc), ru, orig, year);
  }

  function unofficialCards(docs) {
    var out = [], i, c;
    docs = docs || [];
    for (i = 0; i < docs.length; i++) { c = unofficialCard(docs[i]); if (c) out.push(c); }
    return out;
  }

  var KPU = {
    name: 'kpu',
    title: 'kinopoiskapiunofficial.tech',
    host: 'https://kinopoiskapiunofficial.tech/',
    token_key: 'kp_token_unofficial',
    token_default: '',
    limit_key: 'kp_limit_kpu',
    limit_default: 500,

    searchPath: function (query, page) {
      return 'api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(query) + '&page=' + (page || 1);
    },
    parseSearch: function (json) {
      return {
        results: unofficialCards(json && json.films),
        page: 1,
        total_pages: (json && json.pagesCount) || 1,
        total_results: (json && json.searchFilmsCountResult) || 0
      };
    },

    fullPath: function (id) { return 'api/v2.2/films/' + id; },
    parseFull: function (json) {
      var card = unofficialCard(json);
      if (!card) throw new Error('empty');
      var genres = unofficialList(json.genres, 'genre');
      var countries = unofficialList(json.countries, 'country');
      var i;

      card.genres = [];
      for (i = 0; i < genres.length; i++) card.genres.push({ id: i, name: genres[i] });
      card.production_countries = [];
      for (i = 0; i < countries.length; i++) card.production_countries.push({ name: countries[i] });
      card.origin_country = card.production_countries;
      card.production_companies = []; // см. комментарий в devMovie: Lampa не проверяет
      card.tagline = json.slogan || '';
      card.runtime = parseInt(json.filmLength, 10) || 0;

      // Актёры здесь отдельным запросом (api/v1/staff), а каждый запрос — это
      // сутки лимита. На вкладке поиска состав не главное, поэтому не тратим:
      // если нужен состав, карточку откроет kinopoisk.dev, он отдаёт его даром.
      return { movie: card, persons: { id: 0, cast: [], crew: [] }, simular: { results: [] } };
    },

    seasonsPath: function (id) { return 'api/v2.2/films/' + id + '/seasons'; },
    parseSeasons: function (json) {
      var items = (json && json.items) || [], out = {}, i, s, eps, j, list, num;
      for (i = 0; i < items.length; i++) {
        s = items[i];
        num = (s.number != null) ? s.number : (s.episodes && s.episodes[0] && s.episodes[0].seasonNumber);
        if (num == null) continue;
        eps = s.episodes || [];
        list = [];
        for (j = 0; j < eps.length; j++) {
          list.push(episode(eps[j].episodeNumber, num, eps[j].nameRu || eps[j].nameEn,
            eps[j].synopsis, eps[j].releaseDate, ''));
        }
        out[num] = season(num, num, null, null, list);
      }
      return out;
    }
  };

  // Порядок = приоритет. kinopoisk.dev первым: он отдаёт актёров и похожих
  // вместе с карточкой, то есть на ту же карточку тратит меньше запросов.
  var PROVIDERS = [KPDEV, KPU];

  // ===========================================================================
  // Токены и суточные лимиты — по каждому провайдеру отдельно
  // ===========================================================================

  function tokenOf(provider) {
    return cleanString(storageGet(provider.token_key, '')) || provider.token_default;
  }

  function limitOf(provider) {
    var n = parseInt(storageGet(provider.limit_key, provider.limit_default), 10);
    return (n > 0) ? n : provider.limit_default;
  }

  function todayStamp() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }

  function quotaState(provider) {
    var q = storageGet('kp_quota_' + provider.name, null);
    if (!q || typeof q !== 'object' || q.day !== todayStamp()) q = { day: todayStamp(), used: 0 };
    return q;
  }

  function quotaUsed(provider) { return quotaState(provider).used; }

  function quotaSpend(provider) {
    var q = quotaState(provider);
    q.used++;
    storageSet('kp_quota_' + provider.name, q);
  }

  function quotaLeft(provider) { return Math.max(0, limitOf(provider) - quotaUsed(provider)); }

  /**
   * Сервер ответил 403 — суточный лимит кончился. Своему счётчику верить
   * нельзя: встроенный токен общий на всех, кто поставил плагин, поэтому его
   * сутки расходуют чужие устройства. Закрываем провайдера до конца суток,
   * иначе каждый следующий запрос уходит в заведомый отказ.
   */
  function quotaExhaust(provider) {
    storageSet('kp_quota_' + provider.name, { day: todayStamp(), used: limitOf(provider) });
  }

  /** Провайдеры, которыми сейчас есть смысл ходить: с токеном и с остатком. */
  function availableProviders() {
    var out = [], i;
    for (i = 0; i < PROVIDERS.length; i++) {
      if (tokenOf(PROVIDERS[i]) && quotaLeft(PROVIDERS[i]) > 0) out.push(PROVIDERS[i]);
    }
    return out;
  }

  // ===========================================================================
  // Кеш
  //
  // Кешируется РАЗОБРАННЫЙ ответ, поэтому ключ не зависит от провайдера: то же
  // кино, найденное вторым API, ложится в ту же ячейку. В ключе есть вид
  // запроса (kind) — один путь может читаться по-разному.
  // ===========================================================================

  var CACHE_KEY = 'kp_cache';
  var CACHE_LIMIT = 90;
  var memory = {};

  function cacheRead() {
    var c = storageGet(CACHE_KEY, null);
    return (c && typeof c === 'object') ? c : {};
  }

  function cacheGet(key) {
    if (memory[key] && memory[key].until > Date.now()) return memory[key].data;
    var hit = cacheRead()[key];
    if (!hit || hit.until <= Date.now()) return null;
    memory[key] = hit;
    return hit.data;
  }

  // Протухшая запись — последний рубеж, когда лимиты кончились. Вчерашний
  // результат лучше пустого экрана.
  function cacheGetStale(key) {
    if (memory[key]) return memory[key].data;
    var hit = cacheRead()[key];
    return hit ? hit.data : null;
  }

  function cacheSet(key, data, life) {
    var entry = { until: Date.now() + life * 60 * 1000, at: Date.now(), data: data };
    memory[key] = entry;
    var all = cacheRead();
    all[key] = entry;
    var keys = [], k;
    for (k in all) if (all.hasOwnProperty(k)) keys.push(k);
    if (keys.length > CACHE_LIMIT) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      var drop = keys.length - CACHE_LIMIT, i;
      for (i = 0; i < drop; i++) delete all[keys[i]];
    }
    try { storageSet(CACHE_KEY, all); } catch (e) { /* переполнение localStorage — живём без кеша */ }
  }

  function cacheClear() {
    memory = {};
    storageSet(CACHE_KEY, {});
  }

  // ===========================================================================
  // Сеть
  // ===========================================================================

  var CONCURRENCY = 2;
  var MIN_GAP = 220; // мс между стартами: у kinopoisk.dev потолок 5 запросов/сек

  var network = null, queue = [], active = 0, last_start = 0;

  function net() {
    if (!network) {
      network = new Lampa.Reguest();
      if (network.timeout) network.timeout(1000 * 20);
    }
    return network;
  }

  function pump() {
    if (!queue.length || active >= CONCURRENCY) return;
    var gap = MIN_GAP - (Date.now() - last_start);
    if (gap > 0) { setTimeout(pump, gap); return; }
    var job = queue.shift();
    active++;
    last_start = Date.now();
    job(function () { active--; pump(); });
    pump();
  }

  function notyOnce(flag, message) {
    if (window[flag]) return;
    window[flag] = true;
    if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
  }

  /** Один запрос к одному провайдеру. done(parsed) / fail({status}). */
  function requestOne(provider, path, parse, done, fail) {
    queue.push(function (release) {
      quotaSpend(provider);
      net().silent(provider.host + path, function (json) {
        release();
        var data;
        try { data = parse(json); }
        catch (e) { fail({ status: 500, parse: true, provider: provider.name }); return; }
        done(data);
      }, function (xhr) {
        release();
        var status = (xhr && (xhr.status || xhr.decode_code)) || 0;
        // Кинопоиск различает эти случаи, и путать их нельзя: 401 — токен
        // неверный, 403 — токен рабочий, но суточный лимит израсходован.
        if (status === 403) quotaExhaust(provider);
        fail({ status: status || -1, provider: provider.name });
      }, false, {
        dataType: 'json',
        headers: { 'X-API-KEY': tokenOf(provider) },
        cache: { life: LIFE.full }
      });
    });
    pump();
  }

  function warnNoBudget() {
    var withToken = 0, i;
    for (i = 0; i < PROVIDERS.length; i++) if (tokenOf(PROVIDERS[i])) withToken++;
    if (withToken < PROVIDERS.length) {
      notyOnce('kp_need_token', 'Кинопоиск: суточный лимит исчерпан. Добавьте второй токен в ' +
        'Настройки → Кинопоиск — это ещё 500 запросов в сутки (kinopoiskapiunofficial.tech).');
    } else {
      notyOnce('kp_no_budget', 'Кинопоиск: суточный лимит исчерпан по всем токенам. Показаны сохранённые данные.');
    }
  }

  /**
   * Запрос с переключением между провайдерами.
   *
   * @param {string} kind   вид запроса — часть ключа кеша
   * @param {string} key    ключ кеша, одинаковый для обоих провайдеров
   * @param {number} life   время жизни кеша в минутах
   * @param {function} build  (provider) -> {path, parse}
   */
  function get(kind, key, life, build, done, fail) {
    var cache_key = kind + '|' + key;
    var cached = cacheGet(cache_key);
    if (cached !== null) { done(cached); return; }

    var list = availableProviders();
    if (!list.length) {
      var stale = cacheGetStale(cache_key);
      warnNoBudget();
      if (stale !== null) done(stale);
      else fail({ status: 429, quota: true });
      return;
    }

    var i = 0, last = null;
    function attempt() {
      if (i >= list.length) {
        var old = cacheGetStale(cache_key);
        if (old !== null) done(old);
        else fail(last || { status: -1 });
        return;
      }
      var provider = list[i++];
      var spec = build(provider);
      requestOne(provider, spec.path, spec.parse, function (data) {
        cacheSet(cache_key, data, life);
        done(data);
      }, function (err) {
        last = err;
        if (err.status === 401) {
          notyOnce('kp_auth_' + provider.name,
            'Кинопоиск: токен ' + provider.title + ' некорректен. Проверьте его в Настройки → Кинопоиск.');
        }
        attempt(); // 403, 401, сеть — в любом случае пробуем следующего
      });
    }
    attempt();
  }

  // ===========================================================================
  // Источник: поиск
  // ===========================================================================

  function searchQuery(params) {
    var query = (params && params.query) || '';
    // Из общего поиска запрос приходит закодированным, из своего — сырым.
    try { query = decodeURIComponent(query); } catch (e) { /* сырая строка с % */ }
    return query.trim();
  }

  function searchPage(query, page, done, fail) {
    get('search', query.toLowerCase() + '|' + page, LIFE.search, function (provider) {
      return { path: provider.searchPath(query, page), parse: provider.parseSearch };
    }, done, fail);
  }

  function search(params, oncomplite, onerror) {
    var query = searchQuery(params);
    if (!query) { oncomplite([]); return; }

    searchPage(query, 1, function (page) {
      var movies = [], series = [], rows = [], i;
      for (i = 0; i < page.results.length; i++) {
        if (page.results[i].original_name) series.push(page.results[i]);
        else movies.push(page.results[i]);
      }
      if (movies.length) rows.push({ title: 'Фильмы', type: 'movie', results: movies, source: SOURCE, url: '' });
      if (series.length) rows.push({ title: 'Сериалы', type: 'tv', results: series, source: SOURCE, url: '' });
      oncomplite(rows);
    }, function () {
      if (onerror) onerror(); else oncomplite([]);
    });
  }

  /** Вкладка «Кинопоиск» в общем поиске Lampa. */
  function discovery() {
    return {
      title: 'Кинопоиск',
      search: search,
      params: { align_left: true, object: { source: SOURCE } },
      onMore: function (params, close) {
        close();
        Lampa.Activity.push({
          url: '',
          title: 'Кинопоиск — ' + params.query,
          component: 'category_full',
          source: SOURCE,
          query: encodeURIComponent(params.query),
          page: 1
        });
      },
      onCancel: function () { net().clear(); }
    };
  }

  /** Сетка «ещё» из вкладки поиска — тот же поиск, постранично. */
  function list(params, oncomplite, onerror) {
    var query = searchQuery(params);
    if (!query) { oncomplite({ results: [], page: 1, total_pages: 1 }); return; }
    searchPage(query, params.page || 1, function (page) {
      oncomplite({
        results: page.results,
        page: page.page,
        total_pages: page.total_pages,
        total_results: page.total_results,
        source: SOURCE
      });
    }, onerror || function () {});
  }

  // ===========================================================================
  // Источник: карточка, сезоны и серии
  // ===========================================================================

  function loadSeasonMap(id, done) {
    get('season', '' + id, LIFE.season, function (provider) {
      return { path: provider.seasonsPath(id), parse: provider.parseSeasons };
    }, done, function () { done({}); });
  }

  function seasonNumbers(map) {
    var keys = [], k;
    for (k in map) if (map.hasOwnProperty(k)) keys.push(parseInt(k, 10));
    keys.sort(function (a, b) { return a - b; });
    return keys;
  }

  /** Последний НЕ спецвыпуск — его Lampa показывает на карточке сериала. */
  function lastSeason(map) {
    var keys = seasonNumbers(map), i;
    for (i = keys.length - 1; i >= 0; i--) if (keys[i] > 0) return map[keys[i]];
    return keys.length ? map[keys[keys.length - 1]] : null;
  }

  /** Счётчики сезонов и серий — по реальным документам, а не по обещаниям. */
  function applySeasons(movie, map) {
    var keys = seasonNumbers(map), i, n, s, list = [], seasons_count = 0, episodes_count = 0;
    if (!keys.length) return movie;
    for (i = 0; i < keys.length; i++) {
      n = keys[i];
      s = map[n];
      if (n > 0) seasons_count++; // нулевой сезон — спецвыпуски, это не сезон
      episodes_count += s.episodes.length;
      list.push({
        id: s.id, season_number: n, episode_count: s.episodes.length,
        name: s.name, overview: s.overview,
        air_date: (s.episodes[0] && s.episodes[0].air_date) || ''
      });
    }
    movie.number_of_seasons = seasons_count || keys.length;
    movie.number_of_episodes = episodes_count;
    movie.seasons = list;
    return movie;
  }

  function full(params, oncomplite, onerror) {
    params = params || {};
    var id = params.id || (params.card && params.card.id);
    if (!id) { if (onerror) onerror(); return; }

    get('full', '' + id, LIFE.full, function (provider) {
      return { path: provider.fullPath(id), parse: provider.parseFull };
    }, function (data) {
      var out = { movie: data.movie, persons: data.persons, simular: data.simular, source: SOURCE };
      if (!out.movie.original_name) { oncomplite(out); return; }

      // Ни один из двух API не отдаёт сезоны вместе с карточкой, так что для
      // сериала это всегда второй запрос — зато ровно тот же, что потом
      // сделает экран серий, и там он уже будет в кеше.
      loadSeasonMap(id, function (map) {
        applySeasons(out.movie, map);
        var last = lastSeason(map);
        if (last) out.episodes = last;
        oncomplite(out);
      });
    }, onerror || function () {});
  }

  /** Контракт Lampa: seasons(card, [номера сезонов], oncomplite). */
  function seasons(card, from, oncomplite) {
    loadSeasonMap(card.id, function (map) {
      var res = {}, i;
      for (i = 0; i < from.length; i++) if (map[from[i]]) res['' + from[i]] = map[from[i]];
      oncomplite(res);
    });
  }

  // ===========================================================================
  // Остальное по контракту источника
  //
  // Каталога у плагина нет, но Lampa может позвать любой метод источника —
  // например если Кинопоиск когда-то был выбран основным. Честный пустой ответ
  // лучше исключения внутри чужого компонента.
  // ===========================================================================

  function emptyMain(params, oncomplite, onerror) {
    if (onerror) onerror();
    return function (resolve, reject) { if (reject) reject(); };
  }
  function emptyCategory(params, oncomplite, onerror) { if (onerror) onerror(); }
  function emptyMenu(params, oncomplite) { if (oncomplite) oncomplite([]); }
  function person(params, oncomplite, onerror) { if (onerror) onerror(); }
  function clear() { net().clear(); }

  // Картинки Кинопоиска — готовые абсолютные URL. Api.img() всегда подставляет
  // хост TMDB, поэтому такой путь пропускаем насквозь.
  function img(src, size) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    return Lampa.Api.sources.tmdb.img(src, size);
  }

  var KP = {
    SOURCE_NAME: SOURCE,
    search: search,
    discovery: discovery,
    list: list,
    full: full,
    seasons: seasons,
    main: emptyMain,
    category: emptyCategory,
    menu: emptyMenu,
    menuCategory: emptyMenu,
    person: person,
    company: emptyCategory,
    favorite: emptyCategory,
    clear: clear,
    img: img
  };

  // ===========================================================================
  // Настройки
  // ===========================================================================

  function quotaLine() {
    var parts = [], i, p;
    for (i = 0; i < PROVIDERS.length; i++) {
      p = PROVIDERS[i];
      parts.push(p.name + ': ' + (tokenOf(p) ? (quotaUsed(p) + '/' + limitOf(p)) : 'нет токена'));
    }
    return parts.join('   ');
  }

  function addSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;

    Lampa.SettingsApi.addComponent({
      component: 'kinopoisk',
      name: 'Кинопоиск',
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z" fill="currentColor"/><path d="M10 7h2v4l3-4h2.4l-3.4 4.4L17.6 17H15l-3-4.4V17h-2V7z" fill="currentColor"/></svg>'
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_token', type: 'input', values: '', default: '' },
      field: {
        name: 'Токен kinopoisk.dev',
        description: '200 запросов в сутки. Пусто — общий встроенный токен, его лимит делят все. Бот @poiskkinodev_bot'
      },
      onChange: cacheClear
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_token_unofficial', type: 'input', values: '', default: '' },
      field: {
        name: 'Токен kinopoiskapiunofficial.tech',
        description: 'Ещё 500 запросов в сутки. Регистрация на kinopoiskapiunofficial.tech занимает минуту. Пусто — провайдер не используется'
      },
      onChange: cacheClear
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_quota_view', type: 'static' },
      field: { name: 'Израсходовано сегодня', description: 'По каждому токену отдельно, обнуляется раз в сутки' },
      onRender: function (item) {
        setTimeout(function () { item.find('.settings-param__value').text(quotaLine()); }, 0);
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_cache_clear', type: 'button' },
      field: { name: 'Очистить кеш', description: 'Сбросить сохранённые ответы Кинопоиска' },
      onChange: function () {
        cacheClear();
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('Кинопоиск: кеш очищен');
      }
    });
  }

  // ===========================================================================
  // Запуск
  // ===========================================================================

  function registerSource() {
    if (!Lampa.Api || !Lampa.Api.sources) return false;
    Lampa.Api.sources[SOURCE] = KP;

    // Прошлая версия добавляла Кинопоиск в общий выбор источника. Каталога
    // больше нет, так что выбранный «kp» дал бы пустую главную — возвращаем
    // такого пользователя на TMDB.
    if (storageGet('source', 'tmdb') === SOURCE) storageSet('source', 'tmdb');

    return Lampa.Api.sources[SOURCE] === KP;
  }

  function start() {
    if (window.kinopoisk_plugin_ready) return;
    window.kinopoisk_plugin_ready = true;

    if (!registerSource()) {
      if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('Кинопоиск: эта версия Lampa не поддерживает сторонние источники');
      return;
    }

    addSettings();
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });

  // --- хук для тестов (в браузере `module` не существует) ---
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      KP: KP,
      PROVIDERS: PROVIDERS,
      _KPDEV: KPDEV,
      _KPU: KPU,
      _devCard: devCard,
      _devMovie: devMovie,
      _devPersons: devPersons,
      _unofficialCard: unofficialCard,
      _unofficialIsSeries: unofficialIsSeries,
      _applySeasons: applySeasons,
      _lastSeason: lastSeason,
      _searchQuery: searchQuery,
      _get: get,
      _tokenOf: tokenOf,
      _limitOf: limitOf,
      _quotaUsed: quotaUsed,
      _quotaLeft: quotaLeft,
      _quotaSpend: quotaSpend,
      _quotaExhaust: quotaExhaust,
      _availableProviders: availableProviders,
      _cacheGet: cacheGet,
      _cacheClear: cacheClear,
      _registerSource: registerSource,
      _start: start
    };
  }
})();
