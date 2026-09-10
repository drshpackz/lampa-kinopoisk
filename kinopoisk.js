(function () {
  'use strict';

  // ===========================================================================
  // Кинопоиск для Lampa
  //
  // Плагин регистрирует полноценный источник данных `kp` в Lampa.Api.sources,
  // поэтому Кинопоиск работает везде, где работает TMDB: главная лента, полная
  // сетка «ещё», карточка фильма, поиск, актёры, сезоны и серии.
  //
  // Данные берутся из api.poiskkino.dev (зеркало kinopoisk.dev). Ключевое
  // ограничение бесплатного токена — 200 запросов в СУТКИ, поэтому весь
  // сетевой слой построен вокруг кеша: см. блок «Кеш и квота».
  // ===========================================================================

  var SOURCE = 'kp';
  var API = 'https://api.poiskkino.dev/';
  var DEFAULT_TOKEN = 'WC22CBY-RFA4RS0-Q79XE2S-04DR4DH';

  // Lampa меряет время жизни кеша в МИНУТАХ (Request: life * 1000 * 60).
  var HOUR = 60;
  var DAY = 60 * 24;

  // Сколько живёт ответ каждого класса запросов. Каталог обновляется раз в
  // полсуток — этого достаточно, чтобы лента не «застывала», и мало, чтобы
  // не сжечь суточную квоту при обычном пользовании.
  var LIFE = { row: HOUR * 12, list: HOUR * 12, full: DAY * 7, season: DAY * 7, person: DAY * 7, search: HOUR * 2 };

  // ===========================================================================
  // Настройки
  // ===========================================================================

  function storageGet(key, def) {
    return (Lampa.Storage && Lampa.Storage.get) ? Lampa.Storage.get(key, def) : def;
  }
  function storageSet(key, value) {
    if (Lampa.Storage && Lampa.Storage.set) Lampa.Storage.set(key, value);
  }

  function token() {
    var t = storageGet('kp_token', '');
    t = (t === null || t === undefined) ? '' : String(t).trim();
    // Params.field() возвращает строку 'undefined' для незарегистрированных ключей.
    if (!t || t === 'undefined') return DEFAULT_TOKEN;
    return t;
  }

  // Суточный лимит бесплатного токена. Пользователь со своим тарифом поднимает
  // его в настройках плагина.
  function quotaLimit() {
    var n = parseInt(storageGet('kp_quota_limit', 200), 10);
    return (n > 0) ? n : 200;
  }

  // ===========================================================================
  // Кеш и квота
  //
  // Два независимых слоя, потому что оба могут отвалиться по отдельности:
  //
  //  1. Собственный кеш готовых (уже разобранных) ответов в Lampa.Storage. Он
  //     не зависит от настройки Lampa «кешировать запросы» и хранит компактные
  //     карточки, а не сырые ответы Кинопоиска.
  //  2. Штатный кеш Lampa (params.cache.life). Он бесплатный и, что важнее,
  //     при ошибке отдаёт устаревшую копию — то есть когда суточная квота
  //     кончится, лента продолжит открываться.
  //
  // Квота считается нами самими: заголовки X-RateLimit до колбэка jQuery в
  // Lampa не доходят, а узнать «сколько осталось» через /v1.5/token стоит
  // ещё один запрос из тех же двухсот.
  // ===========================================================================

  var CACHE_KEY = 'kp_cache';
  var CACHE_LIMIT = 90; // записей; дальше вытесняем самые старые

  var memory = {}; // кеш на время сессии, чтобы не дёргать Storage на каждый ряд

  function cacheRead() {
    var c = storageGet(CACHE_KEY, null);
    return (c && typeof c === 'object') ? c : {};
  }

  function cacheGet(key) {
    if (memory[key] && memory[key].until > Date.now()) return memory[key].data;
    var all = cacheRead(), hit = all[key];
    if (!hit) return null;
    if (hit.until <= Date.now()) return null;
    memory[key] = hit;
    return hit.data;
  }

  // Устаревшая запись — последний рубеж, когда квота кончилась и сеть отвечает
  // ошибкой. Лучше показать вчерашнюю ленту, чем пустой экран.
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
    try { storageSet(CACHE_KEY, all); } catch (e) { /* переполнение localStorage — просто живём без кеша */ }
  }

  function cacheClear() {
    memory = {};
    storageSet(CACHE_KEY, {});
  }

  function todayStamp() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }

  // Квота Кинопоиска обнуляется в 21:00 UTC, но нам достаточно посуточного
  // счётчика: он никогда не занизит остаток, только завысит расход.
  function quotaState() {
    var q = storageGet('kp_quota', null);
    if (!q || typeof q !== 'object' || q.day !== todayStamp()) q = { day: todayStamp(), used: 0 };
    return q;
  }

  function quotaUsed() { return quotaState().used; }

  function quotaSpend() {
    var q = quotaState();
    q.used++;
    storageSet('kp_quota', q);
    return q.used;
  }

  function quotaLeft() { return Math.max(0, quotaLimit() - quotaUsed()); }

  // ===========================================================================
  // Сетевой слой
  //
  // Кинопоиск отдаёт 5 запросов в секунду, поэтому очередь с ограничением по
  // параллельности и минимальным интервалом: без неё ряды главной стреляют
  // залпом и половина возвращается 429.
  // ===========================================================================

  var CONCURRENCY = 2;
  var MIN_GAP = 220; // мс между стартами запросов

  var network = null;
  var queue = [];
  var active = 0;
  var last_start = 0;

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
    job(function () {
      active--;
      pump();
    });
    pump();
  }

  function enqueue(job) {
    queue.push(job);
    pump();
  }

  function notyOnce(flag, message) {
    if (window[flag]) return;
    window[flag] = true;
    if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
  }

  /**
   * Запрос к API Кинопоиска.
   *
   * В кеш кладётся РАЗОБРАННЫЙ ответ, а не сырой JSON, поэтому ключ обязан
   * различать два прочтения одного пути (например список сезонов как карта и
   * как страница). За это отвечает kind — без него первый вызов отдал бы
   * второму чужую структуру.
   *
   * @param {string} kind   тег вызывающего: 'row' | 'full' | 'season' | ...
   * @param {string} path   путь с query, например 'v1.4/movie?type=movie&page=1'
   * @param {number} life   время жизни кеша в минутах
   * @param {function} parse сырой JSON → то, что кладём в кеш и отдаём наружу
   * @param {function} done принимает УЖЕ разобранный результат
   * @param {function} fail
   */
  function get(kind, path, life, parse, done, fail) {
    var key = kind + '|' + path;
    var cached = cacheGet(key);
    if (cached !== null) { done(cached); return; }

    // Квота кончилась — отдаём протухшее вместо ошибки. Пустой экран здесь
    // хуже вчерашних данных.
    if (quotaLeft() <= 0) {
      var stale = cacheGetStale(key);
      notyOnce('kp_quota_noted', 'Кинопоиск: исчерпан суточный лимит запросов (' + quotaLimit() + '). Показаны сохранённые данные.');
      if (stale !== null) done(stale);
      else fail({ status: 429, quota: true });
      return;
    }

    enqueue(function (release) {
      quotaSpend();
      net().silent(API + path, function (json) {
        release();
        var data;
        try { data = parse(json); }
        catch (e) { fail({ status: 500, parse: true }); return; }
        cacheSet(key, data, life);
        done(data);
      }, function (xhr) {
        release();
        var status = (xhr && (xhr.status || xhr.decode_code)) || 0;
        if (status === 401 || status === 403) notyOnce('kp_auth_noted', 'Кинопоиск: токен не принят (' + status + '). Проверьте его в настройках плагина.');
        var old = cacheGetStale(key);
        if (old !== null) done(old);
        else fail({ status: status || -1 });
      }, false, {
        dataType: 'json',
        headers: { 'X-API-KEY': token() },
        cache: { life: life }
      });
    });
  }

  // ===========================================================================
  // Кинопоиск → карточка Lampa
  //
  // Lampa отличает фильм от сериала по наличию original_name (router 'full':
  // method = data.original_name ? 'tv' : 'movie'). Поэтому у фильма ТОЛЬКО
  // title/original_title, у сериала ТОЛЬКО name/original_name — смешивать
  // нельзя, иначе фильм откроется как сериал.
  //
  // Постеры Кинопоиска — готовые URL, а Api.img() всегда подставляет хост
  // TMDB. Отсюда правило: poster_path НЕ заполняем, кладём poster/img/
  // background_image, которые Lampa берёт как есть.
  // ===========================================================================

  var SERIES_TYPES = { 'tv-series': 1, 'animated-series': 1, 'tv-show': 1 };

  function isSeries(doc) {
    if (doc.isSeries === true) return true;
    if (doc.isSeries === false) return false;
    return !!SERIES_TYPES[doc.type];
  }

  function pickImage(node, prefer_big) {
    if (!node) return '';
    return (prefer_big ? (node.url || node.previewUrl) : (node.previewUrl || node.url)) || '';
  }

  function yearDate(doc) {
    var y = doc.year || (doc.releaseYears && doc.releaseYears[0] && doc.releaseYears[0].start);
    return y ? (y + '-01-01') : '';
  }

  // Единственный рейтинг, который Lampa рисует на карточке — vote_average.
  // Кинопоиск для русской аудитории роднее IMDB, поэтому он и идёт в основной.
  // На полной карточке Lampa переименовывает первый бейдж в имя источника
  // («KP» вместо «TMDB»), так что отдельный kp_rating дал бы ту же оценку
  // вторым бейджем — поэтому его здесь нет, только imdb_rating рядом.
  function ratingOf(doc) {
    var r = doc.rating || {};
    return r.kp || r.imdb || r.tmdb || 0;
  }

  function namesOf(doc) {
    var ru = doc.name || doc.alternativeName || doc.enName || '';
    var orig = doc.alternativeName || doc.enName || doc.name || '';
    return { ru: ru, orig: orig };
  }

  /**
   * Карточка для рядов и сеток. Плоская и маленькая — она уходит в кеш и в
   * избранное (Lampa хранит только поля из своего card_fields).
   */
  function toCard(doc) {
    if (!doc || doc.id == null) return null;
    var n = namesOf(doc);
    var series = isSeries(doc);
    var votes = doc.votes || {};
    var rating = doc.rating || {};

    var card = {
      source: SOURCE,
      id: doc.id,
      kinopoisk_id: doc.id,
      overview: doc.description || doc.shortDescription || '',
      poster: pickImage(doc.poster, false),
      img: pickImage(doc.poster, false),
      background_image: pickImage(doc.backdrop, true),
      vote_average: ratingOf(doc),
      vote_count: votes.kp || votes.imdb || 0,
      imdb_rating: rating.imdb || 0,
      kp_type: doc.type || (series ? 'tv-series' : 'movie')
    };

    if (series) {
      card.name = n.ru;
      card.original_name = n.orig;
      card.first_air_date = yearDate(doc);
    } else {
      card.title = n.ru;
      card.original_title = n.orig;
      card.release_date = yearDate(doc);
    }

    if (doc.externalId && doc.externalId.imdb) card.imdb_id = doc.externalId.imdb;
    if (doc.ageRating != null) card.pg = doc.ageRating + '+';

    return card;
  }

  function toCards(docs) {
    var out = [], i, c;
    docs = docs || [];
    for (i = 0; i < docs.length; i++) { c = toCard(docs[i]); if (c) out.push(c); }
    return out;
  }

  /** Ответ-список Кинопоиска → страница результатов в формате Lampa. */
  function toPage(json, url) {
    return {
      results: toCards(json && json.docs),
      page: (json && json.page) || 1,
      total_pages: (json && json.pages) || 1,
      total_results: (json && json.total) || 0,
      url: url,
      source: SOURCE
    };
  }

  // ===========================================================================
  // Запросы каталога
  // ===========================================================================

  // Поля, которых хватает карточке. Без selectFields Кинопоиск отдаёт документ
  // целиком (со всеми names, facts, watchability) — на 250 карточках это
  // мегабайты трафика на телевизоре.
  var CARD_FIELDS = ['id', 'name', 'alternativeName', 'enName', 'type', 'isSeries', 'year',
    'releaseYears', 'description', 'shortDescription', 'rating', 'votes', 'poster',
    'backdrop', 'genres', 'countries', 'movieLength', 'seriesLength', 'ageRating',
    'ratingMpaa', 'externalId', 'top250'];

  function fieldsQuery(fields) {
    var out = [], i;
    for (i = 0; i < fields.length; i++) out.push('selectFields=' + fields[i]);
    return out.join('&');
  }

  /** Путь ряда/сетки: url ряда + постраничность + служебные поля. */
  function listPath(url, page, limit) {
    var q = url;
    if (q.indexOf('notNullFields=') < 0) q += '&notNullFields=name&notNullFields=poster.url';
    q += '&' + fieldsQuery(CARD_FIELDS);
    q += '&limit=' + (limit || 30) + '&page=' + (page || 1);
    return 'v1.4/movie?' + q;
  }

  function fetchList(url, page, life, done, fail) {
    get('row', listPath(url, page), life, function (json) { return toPage(json, url); }, done, fail);
  }

  // ===========================================================================
  // Ряды главной страницы
  //
  // Каждый ряд — один запрос, поэтому их порядок = порядок трат квоты. Lampa
  // грузит ленту порциями (partNext), так что первое открытие стоит ~6
  // запросов, остальное подтягивается по мере прокрутки и попадает в кеш.
  // ===========================================================================

  function ddmmyyyy(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  var POPULAR = 'sortField=votes.kp&sortType=-1';
  var FRESH = 'sortField=year&sortType=-1';

  // notNullFields на постер уже добавляет listPath; здесь только смысловые фильтры.
  function catalogRows(now) {
    now = now || new Date();
    var year = now.getFullYear();
    var since = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
    var until = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

    return [
      { title: 'Сейчас в кино',
        url: 'type=movie&premiere.russia=' + ddmmyyyy(since) + '-' + ddmmyyyy(until) + '&sortField=premiere.russia&sortType=-1' },
      { title: 'Популярные фильмы',
        url: 'type=movie&rating.kp=6-10&votes.kp=5000-10000000&' + POPULAR },
      { title: 'Популярные сериалы',
        url: 'type=tv-series&rating.kp=6-10&votes.kp=2000-10000000&' + POPULAR },
      { title: 'Новинки кино',
        url: 'type=movie&year=' + (year - 1) + '-' + year + '&votes.kp=500-10000000&' + FRESH },
      { title: 'Новые сериалы',
        url: 'type=tv-series&year=' + (year - 1) + '-' + year + '&votes.kp=200-10000000&' + FRESH },
      { title: 'Топ 250 Кинопоиска',
        url: 'lists=top250&sortField=top250&sortType=1' },
      { title: 'Лучшее по версии зрителей',
        url: 'rating.kp=8-10&votes.kp=100000-10000000&sortField=rating.kp&sortType=-1' },
      { title: 'Российские сериалы',
        url: 'type=tv-series&countries.name=Россия&votes.kp=1000-10000000&' + POPULAR },
      { title: 'Аниме',
        url: 'type=anime&votes.kp=500-10000000&' + POPULAR },
      { title: 'Мультфильмы',
        url: 'type=cartoon&votes.kp=2000-10000000&' + POPULAR }
    ];
  }

  // Жанры Кинопоиска фильтруются по русскому имени, а не по id.
  var GENRE_ROWS = [
    { title: 'Боевики', genre: 'боевик' },
    { title: 'Комедии', genre: 'комедия' },
    { title: 'Драмы', genre: 'драма' },
    { title: 'Триллеры', genre: 'триллер' },
    { title: 'Фантастика', genre: 'фантастика' },
    { title: 'Ужасы', genre: 'ужасы' },
    { title: 'Детективы', genre: 'детектив' },
    { title: 'Мелодрамы', genre: 'мелодрама' },
    { title: 'Криминал', genre: 'криминал' },
    { title: 'Приключения', genre: 'приключения' },
    { title: 'Фэнтези', genre: 'фэнтези' },
    { title: 'Военные', genre: 'военный' }
  ];

  function genreRows() {
    var out = [], i, g;
    for (i = 0; i < GENRE_ROWS.length; i++) {
      g = GENRE_ROWS[i];
      out.push({
        title: g.title,
        url: 'genres.name=' + encodeURIComponent(g.genre) + '&rating.kp=5-10&votes.kp=1000-10000000&' + POPULAR
      });
    }
    return out;
  }

  function allRows(now) {
    return catalogRows(now).concat(genreRows());
  }

  // ===========================================================================
  // Источник: главная лента
  // ===========================================================================

  function rowLoader(row) {
    return function (call) {
      fetchList(row.url, 1, LIFE.row, function (page) {
        page.title = row.title;
        call(page.results.length ? page : {});
      }, function () { call({}); });
    };
  }

  function main(params, oncomplite, onerror) {
    params = params || {};
    var parts_limit = 5; // порций на экран; остальное — по прокрутке
    var parts = [], rows = allRows(), i;
    for (i = 0; i < rows.length; i++) parts.push(rowLoader(rows[i]));

    function loadPart(partLoaded, partEmpty) {
      Lampa.Api.partNext(parts, parts_limit, partLoaded, partEmpty);
    }

    loadPart(oncomplite, onerror);
    return loadPart;
  }

  // ===========================================================================
  // Источник: сетка «ещё» и категории
  // ===========================================================================

  function list(params, oncomplite, onerror) {
    params = params || {};
    var url = params.url || ('type=movie&' + POPULAR);
    fetchList(url, params.page || 1, LIFE.list, oncomplite, onerror || function () {});
  }

  // Пункты «Фильмы» / «Сериалы» из меню Lampa приходят сюда с url 'movie'|'tv'.
  function category(params, oncomplite, onerror) {
    params = params || {};
    var tv = params.url === 'tv';
    var base = tv ? 'type=tv-series' : 'type=movie';
    var parts = [
      { title: tv ? 'Популярные сериалы' : 'Популярные фильмы', url: base + '&rating.kp=6-10&votes.kp=2000-10000000&' + POPULAR },
      { title: 'Новинки', url: base + '&year=' + ((new Date()).getFullYear() - 1) + '-' + (new Date()).getFullYear() + '&votes.kp=200-10000000&' + FRESH },
      { title: 'Высокий рейтинг', url: base + '&rating.kp=8-10&votes.kp=50000-10000000&sortField=rating.kp&sortType=-1' }
    ];
    var loaders = [], i;
    for (i = 0; i < parts.length; i++) loaders.push(rowLoader(parts[i]));
    var genres = genreRows();
    for (i = 0; i < genres.length; i++) {
      loaders.push(rowLoader({ title: genres[i].title, url: genres[i].url + '&' + base }));
    }

    function loadPart(partLoaded, partEmpty) {
      Lampa.Api.partNext(loaders, 5, partLoaded, partEmpty);
    }
    loadPart(oncomplite, onerror);
    return loadPart;
  }

  // ===========================================================================
  // Источник: полная карточка
  //
  // Кинопоиск отдаёт всё одним документом (персоны, похожие, сиквелы), так что
  // карточка фильма — ОДИН запрос вместо пяти у TMDB. Для сериала добавляется
  // второй за списком сезонов.
  // ===========================================================================

  var PROFESSION_JOB = {
    director: 'Director',
    writer: 'Writer',
    producer: 'Producer',
    composer: 'Original Music Composer',
    operator: 'Director of Photography',
    editor: 'Editor',
    designer: 'Production Design'
  };

  function personCard(p) {
    return {
      id: p.id,
      name: p.name || p.enName || '',
      original_name: p.enName || p.name || '',
      img: p.photo || '',
      poster: p.photo || '',
      source: SOURCE
    };
  }

  function splitPersons(persons) {
    var cast = [], crew = [], i, p, c;
    persons = persons || [];
    for (i = 0; i < persons.length; i++) {
      p = persons[i];
      if (!p || p.id == null) continue;
      c = personCard(p);
      if (p.enProfession === 'actor') {
        c.character = p.description || '';
        cast.push(c);
      } else {
        c.job = PROFESSION_JOB[p.enProfession] || p.profession || p.enProfession || '';
        c.department = p.enProfession || '';
        crew.push(c);
      }
    }
    return { id: 0, cast: cast, crew: crew };
  }

  /** Полный документ Кинопоиска → объект movie в формате Lampa. */
  function toMovie(doc) {
    var card = toCard(doc);
    var series = isSeries(doc);
    var genres = doc.genres || [], countries = doc.countries || [];
    var i, out;

    out = card;
    out.genres = [];
    for (i = 0; i < genres.length; i++) out.genres.push({ id: genres[i].id || i, name: genres[i].name, url: 'genres.name=' + encodeURIComponent(genres[i].name) + '&' + POPULAR });

    out.production_companies = [];
    if (doc.networks && doc.networks.items) {
      for (i = 0; i < doc.networks.items.length; i++) out.production_companies.push({ id: i, name: doc.networks.items[i].name });
    }

    out.production_countries = [];
    for (i = 0; i < countries.length; i++) out.production_countries.push({ name: countries[i].name });
    out.origin_country = out.production_countries;

    out.tagline = doc.slogan || '';
    out.status = doc.status || '';
    out.runtime = doc.movieLength || doc.seriesLength || 0;

    // seasonsInfo в ответе /movie/{id} обычно нет — настоящие сезоны приходят
    // из /v1.4/season (см. applySeasons). Здесь лишь то, что дал документ,
    // чтобы карточка не была пустой, если запрос сезонов не удался.
    if (series) {
      var info = doc.seasonsInfo || [];
      out.number_of_seasons = info.length;
      out.number_of_episodes = 0;
      out.seasons = [];
      for (i = 0; i < info.length; i++) {
        out.number_of_episodes += (info[i].episodesCount || 0);
        out.seasons.push({
          id: doc.id + '-' + info[i].number,
          season_number: info[i].number,
          episode_count: info[i].episodesCount || 0,
          name: 'Сезон ' + info[i].number
        });
      }
    }

    // Рейтинги в шапке: Lampa рисует vote_average, а kp_rating/imdb_rating
    // подхватывают плагины рейтингов.
    out.source = SOURCE;
    return out;
  }

  function full(params, oncomplite, onerror) {
    params = params || {};
    var id = params.id || (params.card && params.card.id);
    if (!id) { if (onerror) onerror(); return; }

    get('full', 'v1.4/movie/' + id, LIFE.full, function (json) {
      if (!json || json.id == null) throw new Error('empty');
      var movie = toMovie(json);
      var data = {
        movie: movie,
        persons: splitPersons(json.persons),
        simular: { results: toCards(json.similarMovies), title: 'Похожие' },
        recomend: { results: toCards(json.sequelsAndPrequels), title: 'Сиквелы и приквелы' },
        source: SOURCE,
        // seasonsInfo нужен seasons() ниже, чтобы не ходить в сеть повторно
        kp_seasons: json.seasonsInfo || []
      };
      return data;
    }, function (data) {
      // /v1.4/movie/{id} НЕ отдаёт seasonsInfo (проверено на реальном ответе),
      // поэтому сезоны сериала всегда берём из /v1.4/season — он и есть
      // источник правды. Запрос тот же, что потом сделает экран серий, так
      // что кеш переиспользуется и второй раз квоту не тратит.
      if (!data.movie.original_name) { oncomplite(data); return; }
      loadSeasonMap(id, function (map) {
        applySeasons(data.movie, map);
        var last = lastSeason(map);
        if (last) data.episodes = last;
        oncomplite(data);
      });
    }, onerror || function () {});
  }

  // ===========================================================================
  // Источник: сезоны и серии
  // ===========================================================================

  function toEpisode(ep, season_number) {
    return {
      id: ep.id || (season_number + '-' + ep.number),
      episode_number: ep.number,
      season_number: season_number,
      name: ep.name || ep.enName || ('Серия ' + ep.number),
      overview: ep.description || ep.enDescription || '',
      air_date: (ep.airDate || '').slice(0, 10),
      img: pickImage(ep.still, true),
      still_path: null,
      vote_average: 0
    };
  }

  function toSeason(doc) {
    var eps = doc.episodes || [], out = [], i;
    for (i = 0; i < eps.length; i++) out.push(toEpisode(eps[i], doc.number));
    return {
      id: doc.movieId + '-' + doc.number,
      season_number: doc.number,
      name: doc.name || ('Сезон ' + doc.number),
      overview: doc.description || '',
      episodes: out,
      source: SOURCE
    };
  }

  // Один и тот же путь для карточки и для экрана серий — тогда открытие
  // сезонов уже лежит в кеше и не стоит ни одного запроса.
  var SEASON_LIMIT = 50;

  function seasonPath(movie_id) {
    return 'v1.4/season?movieId=' + movie_id + '&limit=' + SEASON_LIMIT + '&page=1&sortField=number&sortType=1';
  }

  /** Все сезоны сериала одним запросом: { <номер сезона>: сезон }. */
  function loadSeasonMap(movie_id, done) {
    get('season', seasonPath(movie_id), LIFE.season, function (json) {
      var docs = (json && json.docs) || [], out = {}, i, s;
      for (i = 0; i < docs.length; i++) {
        s = toSeason(docs[i]);
        if (s.season_number == null) continue;
        out[s.season_number] = s;
      }
      return out;
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

  /**
   * Проставить сериалу счётчики сезонов и серий по реальным документам.
   * Пустая карта ничего не трогает — остаётся то, что дал сам документ фильма.
   */
  function applySeasons(movie, map) {
    var keys = seasonNumbers(map), i, n, season, list = [], seasons_count = 0, episodes_count = 0;
    if (!keys.length) return movie;

    for (i = 0; i < keys.length; i++) {
      n = keys[i];
      season = map[n];
      if (n > 0) seasons_count++;
      episodes_count += season.episodes.length;
      list.push({
        id: season.id,
        season_number: n,
        episode_count: season.episodes.length,
        name: season.name,
        overview: season.overview,
        air_date: (season.episodes[0] && season.episodes[0].air_date) || ''
      });
    }

    movie.number_of_seasons = seasons_count || keys.length;
    movie.number_of_episodes = episodes_count;
    movie.seasons = list;
    return movie;
  }

  /** Контракт Lampa: seasons(card, [номера сезонов], oncomplite). */
  function seasons(card, from, oncomplite) {
    loadSeasonMap(card.id, function (map) {
      var res = {}, i;
      for (i = 0; i < from.length; i++) {
        if (map[from[i]]) res['' + from[i]] = map[from[i]];
      }
      oncomplite(res);
    });
  }

  // ===========================================================================
  // Источник: поиск
  // ===========================================================================

  function searchPath(query, page) {
    return 'v1.4/movie/search?query=' + encodeURIComponent(query) + '&limit=30&page=' + (page || 1);
  }

  function search(params, oncomplite, onerror) {
    params = params || {};
    var query = params.query || '';
    // Из общего поиска запрос приходит закодированным, из своего — сырым.
    try { query = decodeURIComponent(query); } catch (e) { /* сырая строка с % */ }
    if (!query) { oncomplite([]); return; }

    get('search', searchPath(query, params.page || 1), LIFE.search, function (json) {
      return toCards(json && json.docs);
    }, function (cards) {
      var movies = [], series = [], i;
      for (i = 0; i < cards.length; i++) {
        if (cards[i].original_name) series.push(cards[i]);
        else movies.push(cards[i]);
      }
      var rows = [];
      if (movies.length) rows.push({ title: 'Фильмы', type: 'movie', results: movies, source: SOURCE, url: '' });
      if (series.length) rows.push({ title: 'Сериалы', type: 'tv', results: series, source: SOURCE, url: '' });
      oncomplite(rows);
    }, function () {
      if (onerror) onerror(); else oncomplite([]);
    });
  }

  // Вкладка «Кинопоиск» в общем поиске Lampa.
  function discovery() {
    return {
      title: 'Кинопоиск',
      search: search,
      params: { align_left: true, object: { source: SOURCE } },
      onMore: function (params, close) {
        close();
        Lampa.Activity.push({
          url: '',
          title: 'Поиск — ' + params.query,
          component: 'category_full',
          source: SOURCE,
          query: encodeURIComponent(params.query),
          page: 1
        });
      },
      onCancel: function () { net().clear(); }
    };
  }

  // ===========================================================================
  // Источник: страница актёра
  // ===========================================================================

  function personCredits(doc) {
    var movies = doc.movies || [], cast = [], crew = [], i, m, card;
    for (i = 0; i < movies.length; i++) {
      m = movies[i];
      if (!m || m.id == null) continue;
      card = {
        source: SOURCE,
        id: m.id,
        kinopoisk_id: m.id,
        vote_average: m.rating || 0,
        vote_count: 0,
        year: 0,
        media_type: 'movie'
      };
      // У /person нет типа тайтла, поэтому все работы идут как фильмы: иначе
      // половина карточек открывалась бы неправильным методом.
      card.title = m.name || m.alternativeName || '';
      card.original_title = m.alternativeName || m.name || '';
      card.release_date = '';
      if (m.enProfession === 'actor') { card.character = m.description || ''; cast.push(card); }
      else { card.job = PROFESSION_JOB[m.enProfession] || m.enProfession || ''; card.department = m.enProfession || 'acting'; crew.push(card); }
    }
    return { cast: cast, crew: crew };
  }

  function person(params, oncomplite, onerror) {
    params = params || {};
    get('person', 'v1.4/person/' + params.id, LIFE.person, function (json) {
      if (!json || json.id == null) throw new Error('empty');
      var credits = personCredits(json);
      var p = {
        id: json.id,
        name: json.name || json.enName || '',
        original_name: json.enName || json.name || '',
        birthday: (json.birthday || '').slice(0, 10),
        deathday: (json.death || '').slice(0, 10),
        place_of_birth: (json.birthPlace && json.birthPlace[0] && json.birthPlace[0].value) || '',
        biography: (json.facts && json.facts[0] && json.facts[0].value) || '',
        known_for_department: json.enProfession || 'acting',
        img: json.photo || '',
        poster: json.photo || '',
        source: SOURCE
      };
      var movies = credits.cast.concat(credits.crew);
      return {
        person: p,
        credits: {
          raw: credits,
          cast: credits.cast,
          crew: credits.crew,
          movie: credits.cast,
          tv: [],
          knownFor: movies.length ? [{ name: 'Фильмы', credits: movies.slice(0, 40), vote_count: 0 }] : []
        }
      };
    }, oncomplite, onerror || function () {});
  }

  // ===========================================================================
  // Источник: остальное по контракту Lampa
  // ===========================================================================

  function menu(params, oncomplite) {
    var out = [], i;
    for (i = 0; i < GENRE_ROWS.length; i++) out.push({ title: GENRE_ROWS[i].title, id: GENRE_ROWS[i].genre });
    oncomplite(out);
  }

  function menuCategory(params, oncomplite) {
    var tv = params && params.action === 'tv';
    var base = tv ? 'type=tv-series' : 'type=movie';
    oncomplite([
      { title: 'Популярное', url: base + '&rating.kp=6-10&votes.kp=2000-10000000&' + POPULAR, source: SOURCE },
      { title: 'Новинки', url: base + '&year=' + ((new Date()).getFullYear() - 1) + '-' + (new Date()).getFullYear() + '&' + FRESH, source: SOURCE },
      { title: 'Высокий рейтинг', url: base + '&rating.kp=8-10&votes.kp=50000-10000000&sortField=rating.kp&sortType=-1', source: SOURCE }
    ]);
  }

  function company(params, oncomplite, onerror) { if (onerror) onerror(); }
  function favorite(params, oncomplite, onerror) { if (onerror) onerror(); }
  function clear() { net().clear(); }

  // Кинопоиск отдаёт абсолютные URL картинок, но Lampa местами всё равно зовёт
  // Api.img(); пропускаем такой путь насквозь, чтобы не получить битую ссылку.
  function img(src, size) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    return Lampa.Api.sources.tmdb.img(src, size);
  }

  var KP = {
    SOURCE_NAME: SOURCE,
    main: main,
    menu: menu,
    menuCategory: menuCategory,
    full: full,
    list: list,
    category: category,
    search: search,
    discovery: discovery,
    person: person,
    seasons: seasons,
    company: company,
    favorite: favorite,
    clear: clear,
    img: img
  };

  // ===========================================================================
  // Настройки плагина
  // ===========================================================================

  function settingsHtml() {
    return '<div class="settings-param selector" data-name="kp_token" data-type="input" data-string="true">' +
      '<div class="settings-param__name">Токен API</div>' +
      '<div class="settings-param__value"></div>' +
      '<div class="settings-param__descr">Свой токен из бота @poiskkinodev_bot. Пусто — встроенный.</div>' +
      '</div>';
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
      param: { name: 'kp_token', type: 'input', values: '', placeholder: 'Оставьте пустым для встроенного токена', default: '' },
      field: { name: 'Токен API', description: 'Личный токен из бота @poiskkinodev_bot' },
      onChange: function () { cacheClear(); }
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_quota_limit', type: 'select', values: { 200: '200 (бесплатный)', 500: '500', 5000: '5000', 100000: 'Без ограничений' }, default: 200 },
      field: { name: 'Суточный лимит запросов', description: 'Плагин перестаёт ходить в сеть, когда лимит исчерпан, и показывает сохранённые данные' }
    });

    Lampa.SettingsApi.addParam({
      component: 'kinopoisk',
      param: { name: 'kp_quota_view', type: 'static' },
      field: { name: 'Израсходовано сегодня', description: 'Счётчик обнуляется раз в сутки' },
      onRender: function (item) {
        setTimeout(function () {
          item.find('.settings-param__value').text(quotaUsed() + ' из ' + quotaLimit());
        }, 0);
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
  // Меню и запуск
  // ===========================================================================

  var ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M10 7.4h1.9v3.9l2.8-3.9h2.2l-3.2 4.3 3.4 4.9h-2.3l-2.9-4.4v4.4H10V7.4z" fill="currentColor"/></svg>';

  function openCatalog() {
    Lampa.Activity.push({
      url: '',
      title: 'Кинопоиск',
      component: 'main',
      source: SOURCE,
      page: 1
    });
  }

  function addMenuItem() {
    var item = $(
      '<li class="menu__item selector" data-action="kinopoisk">' +
      '<div class="menu__ico">' + ICON + '</div>' +
      '<div class="menu__text">Кинопоиск</div>' +
      '</li>'
    );
    item.on('hover:enter', openCatalog);
    $('.menu .menu__list').eq(0).append(item);
  }

  function registerSource() {
    if (!Lampa.Api || !Lampa.Api.sources) return false;
    // tmdb и cub защищены геттерами, но новые ключи объекту добавляются.
    Lampa.Api.sources[SOURCE] = KP;
    // Источник в общем списке настроек — тогда Кинопоиск можно сделать
    // основным для всего приложения, а не только для своего пункта меню.
    if (Lampa.Params && Lampa.Params.select) {
      Lampa.Params.select('source', { tmdb: 'TMDB', cub: 'CUB', kp: 'Кинопоиск' }, 'tmdb');
    }
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
    addMenuItem();
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });

  // --- хук для тестов (в браузере `module` не существует, блок не исполняется) ---
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      KP: KP,
      _toCard: toCard,
      _toCards: toCards,
      _toPage: toPage,
      _toMovie: toMovie,
      _toSeason: toSeason,
      _applySeasons: applySeasons,
      _lastSeason: lastSeason,
      _loadSeasonMap: loadSeasonMap,
      _toEpisode: toEpisode,
      _isSeries: isSeries,
      _splitPersons: splitPersons,
      _personCredits: personCredits,
      _catalogRows: catalogRows,
      _genreRows: genreRows,
      _allRows: allRows,
      _listPath: listPath,
      _searchPath: searchPath,
      _seasonPath: seasonPath,
      _fieldsQuery: fieldsQuery,
      _get: get,
      _token: token,
      _quotaUsed: quotaUsed,
      _quotaLeft: quotaLeft,
      _quotaSpend: quotaSpend,
      _cacheGet: cacheGet,
      _cacheSet: cacheSet,
      _cacheClear: cacheClear,
      _registerSource: registerSource,
      _addMenuItem: addMenuItem,
      _openCatalog: openCatalog,
      _start: start
    };
  }
})();
