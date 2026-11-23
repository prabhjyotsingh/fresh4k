// fresh4k TV service: talks to the Stalker portal on behalf of the UI.
// Port of server.py's Stalker client. The page calls one method, "api",
// with the same paths and params the MAG server uses (/api/vod/...).
// Plain ES5 + core modules only: the TV runs Node 12.
var Service = require('webos-service');
var http = require('http');
var querystring = require('querystring');
var fs = require('fs');
var path = require('path');

var service = new Service('com.fresh4k.app.service');
var cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
var base = cfg.portal.replace(/\/+$/, '');
var endpoint = base + cfg.api_path;
var token = null;

// ---------------------------------------------------------------- transport
// One request to the portal. Mirrors server.py Stalker._request().
function request(params, cb) {
  params = Object.assign({}, params, { JsHttpRequest: '1-xml' });
  var url = endpoint + '?' + querystring.stringify(params);
  var headers = {
    'User-Agent': cfg.user_agent,
    'X-User-Agent': 'Model: ' + cfg.model + '; Link: ' + cfg.link,
    'Referer': base + '/stalker_portal/c/',
    'Accept': '*/*',
    'Cookie': 'mac=' + encodeURIComponent(cfg.mac) + '; stb_lang=en; timezone=' + encodeURIComponent(cfg.timezone)
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var req = http.get(url, { headers: headers, timeout: 20000 }, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      if (res.statusCode !== 200) return cb('portal HTTP ' + res.statusCode);
      if (body.indexOf('Authorization failed') >= 0) return cb('AUTH');
      var data;
      try { data = JSON.parse(body); } catch (e) { return cb('portal returned non-JSON'); }
      cb(null, data && data.js !== undefined ? data.js : data);
    });
  });
  req.on('timeout', function () { req.abort(); cb('timeout'); });
  req.on('error', function (e) { cb(String(e.message || e)); });
}

// Handshake + get_profile, like server.py Stalker.login().
function login(cb) {
  token = null;
  request({ type: 'stb', action: 'handshake', token: '', prehash: 'false' }, function (err, js) {
    if (err) return cb(err);
    if (!js || !js.token) return cb('handshake returned no token');
    token = js.token;
    var metrics = JSON.stringify({ mac: cfg.mac, sn: cfg.sn, model: cfg.model, type: 'STB',
      uid: cfg.device_id2, random: js.random || '' });
    request({
      type: 'stb', action: 'get_profile', hd: 1,
      ver: 'ImageDescription: ' + cfg.image_desc + '; PORTAL version: 5.6.10; API Version: JS API version: 349',
      num_banks: 1, sn: cfg.sn, stb_type: cfg.model, client_type: 'STB',
      image_version: cfg.image_version, video_out: 'hdmi',
      device_id: cfg.device_id, device_id2: cfg.device_id2,
      signature: cfg.signature, auth_second_step: 0,
      hw_version: cfg.hw_version, not_valid_token: 0, metrics: metrics,
      hw_version_2: cfg.hw_version_2, timestamp: Math.floor(Date.now() / 1000),
      api_signature: 241, prehash: 'false'
    }, function (err2, profile) {
      if (err2) return cb(err2);
      var status = String((profile && profile.status) !== undefined ? profile.status : '0');
      if (status !== '0') return cb('login refused, status ' + status + ': ' + ((profile && profile.msg) || ''));
      cb(null, { status: status });
    });
  });
}

// Logged-in call: log in on first use, and re-login once if the token expired.
function call(params, cb) {
  var ensure = token ? function (f) { f(null); } : login;
  ensure(function (err) {
    if (err) return cb(err);
    request(params, function (e, js) {
      if (e !== 'AUTH') return cb(e, js);
      login(function (e2) {
        if (e2) return cb(e2);
        request(params, cb);
      });
    });
  });
}

// ------------------------------------------------------------------ helpers
// server.py clean_cmd(): drop the "ffmpeg " style prefix.
function cleanCmd(cmd) {
  return String(cmd || '').replace(/^\s+|\s+$/g, '').replace(/^(ffmpeg|ffrt\d?|auto)\s+/, '');
}

function absUrl(uri) {
  if (!uri) return '';
  if (/^http/.test(uri)) return uri;
  return base + (uri.charAt(0) === '/' ? '' : '/') + uri;
}

// server.py _vod_item(): the shape app.js expects.
function vodItem(x) {
  return {
    id: String(x.id),
    category_id: String(x.category_id || ''),
    name: x.name || x.o_name || '',
    year: x.year || '',
    rating: x.rating_imdb || x.rating_kinopoisk || '',
    genres: x.genres_str || '',
    director: x.director || '',
    actors: x.actors || '',
    time: x.time || '',
    description: x.description || '',
    poster: absUrl(x.screenshot_uri),
    cmd: x.cmd || '',
    is_series: String(x.is_series === undefined ? '0' : x.is_series) === '1',
    is_season: !!x.is_season,
    is_episode: !!x.is_episode,
    is_file: !!x.is_file,
    series_number: String(x.series_number || ''),
    series: x.series || []
  };
}

// server.py _page(): one page of results.
function pageOf(js, mapper) {
  js = js || {};
  return {
    total: parseInt(js.total_items, 10) || 0,
    per_page: parseInt(js.max_page_items, 10) || 14,
    items: (js.data || []).map(mapper || vodItem)
  };
}

// ---------------------------------------------------------------------- VOD
// Adult content is locked by default: categories whose title says so, plus any
// ids in config "locked_categories", are hidden from the menu and from search.
// The portal's own "censored" flag is 0 on everything, so it can't be used.
// Set "adult_lock": false in config.json to turn this off.
var ADULT_TITLE = /adult|18\+|xxx|porn/i;
var lockedCache = null;
var adultUnlocked = false;   // set by the PIN; resets when the service restarts

function lockActive() { return cfg.adult_lock !== false && !adultUnlocked; }

// Menu row to unlock or lock adult content; none unless adult_pin is set.
// Mirrors server.py adult_row().
function adultRow() {
  if (!cfg.adult_pin) return null;
  if (adultUnlocked) return { id: 'adult-lock', title: 'Lock adult content', adult: 'lock' };
  return { id: 'adult-unlock', title: 'Adult content (PIN)', adult: 'unlock' };
}

function lockedFrom(js) {
  var set = {};
  (cfg.locked_categories || []).forEach(function (i) { set[String(i)] = true; });
  (js || []).forEach(function (c) {
    if (ADULT_TITLE.test(c.title || '')) set[String(c.id)] = true;
  });
  return set;
}

function lockedSet(cb) {
  if (!lockActive()) return cb(null, {});
  if (lockedCache) return cb(null, lockedCache);
  call({ type: 'vod', action: 'get_categories' }, function (err, js) {
    if (err) return cb(err);
    lockedCache = lockedFrom(js);
    cb(null, lockedCache);
  });
}

function vodCategoryList(cb) {
  call({ type: 'vod', action: 'get_categories' }, function (err, js) {
    if (err) return cb(err);
    var locked = lockActive() ? lockedFrom(js) : {};
    lockedCache = locked;
    var cats = [], byId = {};
    (js || []).forEach(function (c) {
      if (String(c.id) === '*' || locked[String(c.id)]) return;
      var item = { id: String(c.id), title: c.title };
      cats.push(item);
      byId[item.id] = item;
    });
    // server.py vod_categories(): group under section headers, in config order.
    var groups = cfg.vod_groups || [];
    if (groups.length) {
      var out = [];
      groups.forEach(function (g) {
        var members = (g.ids || []).filter(function (i) { return byId[String(i)]; })
          .map(function (i) { return byId[String(i)]; });
        if (!members.length) return;
        out.push({ header: g.title || '' });
        out = out.concat(members);
      });
      return cb(null, out);
    }
    var wanted = (cfg.vod_categories || []).map(String);
    if (wanted.length) {
      return cb(null, wanted.filter(function (i) { return byId[i]; }).map(function (i) { return byId[i]; }));
    }
    cb(null, cats);
  });
}

// Adult category ids, whether or not they are unlocked right now (cached).
// Used to flag adult titles so they stay out of Continue watching.
var adultCache = null;
function adultIds(cb) {
  if (cfg.adult_lock === false) return cb(null, {});
  if (adultCache) return cb(null, adultCache);
  call({ type: 'vod', action: 'get_categories' }, function (err, js) {
    if (err) return cb(err);
    adultCache = lockedFrom(js);
    cb(null, adultCache);
  });
}

// The category menu, plus the adult unlock/lock row (server.py vod_categories()).
function vodCategories(cb) {
  vodCategoryList(function (err, list) {
    if (err) return cb(err);
    var row = adultRow();
    cb(null, row ? list.concat([row]) : list);
  });
}

// server.py vod_list(): category "*" searches everything.
function vodList(category, page, search, cb) {
  var p = { type: 'vod', action: 'get_ordered_list', category: category || '*', genre: '*',
    p: page || 1, sortby: 'added', fav: 0 };
  if (search) p.search = search;
  call(p, function (err, js) {
    if (err) return cb(err);
    var res = pageOf(js);
    lockedSet(function (e2, locked) {
      if (e2) return cb(e2);
      res.items = res.items.filter(function (x) { return !locked[x.category_id]; });
      adultIds(function (e3, adult) {
        if (e3) return cb(e3);
        res.items.forEach(function (x) { x.adult = !!adult[x.category_id]; });
        cb(null, res);
      });
    });
  });
}

// server.py vod_children(): seasons, episodes, or files. Returns every page.
function vodChildren(movieId, seasonId, episodeId, cb) {
  var items = [], page = 1, total = 1;
  (function next() {
    if (items.length >= total || page > 20) return cb(null, { total: items.length, per_page: items.length, items: items });
    call({ type: 'vod', action: 'get_ordered_list', category: '*', movie_id: movieId,
      season_id: seasonId || '0', episode_id: episodeId || '0', fav: 0, sortby: 'added',
      hd: 0, not_ended: 0, p: page }, function (err, js) {
      if (err) return cb(err);
      var res = pageOf(js);
      if (!res.items.length) return cb(null, { total: items.length, per_page: items.length, items: items });
      items = items.concat(res.items);
      total = res.total;
      page++;
      next();
    });
  })();
}

// server.py vod_play(): title -> playable file -> stream link.
function vodPlay(movieId, seasonId, episodeId, series, cb) {
  vodChildren(movieId, seasonId, episodeId, function (err, res) {
    if (err) return cb(err);
    var files = res.items.filter(function (f) { return f.is_file; });
    if (!files.length) return cb('no playable file for this title');
    call({ type: 'vod', action: 'create_link', cmd: '/media/file_' + files[0].id + '.mpg',
      series: series || '', forced_storage: '', disable_ad: 0, download: 0, force_ch_link_check: 0 },
      function (e2, link) {
        if (e2) return cb(e2);
        var raw = (link && link.cmd) || '';
        var url = cleanCmd(raw);
        if (!url) return cb('portal returned no stream URL');
        cb(null, { url: url, cmd: raw });
      });
  });
}

// PIN for adult content (cfg.adult_pin, from config.json). Mirrors server.py adult_unlock().
function adultUnlock(pin, cb) {
  if (!cfg.adult_pin) return cb('no adult PIN set in config.json');
  if (String(pin) !== String(cfg.adult_pin)) return cb('wrong PIN');
  adultUnlocked = true;
  lockedCache = null;
  cb(null, { ok: true });
}

function adultLock(cb) {
  adultUnlocked = false;
  lockedCache = null;
  cb(null, { ok: true });
}

// server.py vod_release(): free the stream slot on the portal.
function vodRelease(url, cb) {
  call({ type: 'vod', action: 'del_link', item: url }, function () { cb(null, { ok: true }); });
}

// ---------------------------------------------------------------- Live TV
// server.py live_genres(): adult genres are hidden like adult VOD categories.
// group: omitted -> the top-level menu; a group key -> that group's genres (with a back row).
function liveGenres(group, cb) {
  call({ type: 'itv', action: 'get_genres' }, function (err, js) {
    if (err) return cb(err);
    var genres = [];
    (js || []).forEach(function (g) {
      if (lockActive() && ADULT_TITLE.test(g.title || '')) return;
      genres.push({ id: String(g.id), title: g.title });
    });
    var grouped = groupLive(genres);
    if (!group) {
      var row = adultRow();
      return cb(null, row ? grouped.top.concat([row]) : grouped.top);
    }
    var subs = grouped.subs[group] || [];
    cb(null, [{ id: 'back', title: '< All groups', back: true }].concat(subs));
  });
}

// Same rule as server.py group_live(): All, then one row per group (from the first
// '|' part). A group with one genre goes under OTHER.
function groupLive(genres) {
  var top = [], groups = {}, order = [], subs = {}, others = [];
  genres.forEach(function (g) {
    if (g.id === '*') { top.push(g); return; }
    var parts = g.title.split('|');
    var key = (parts[0] || '').trim().toUpperCase() || 'OTHER';
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ g: g, parts: parts });
  });
  order.slice().sort().forEach(function (key) {   // groups and their genres sorted by name
    var items = groups[key];
    if (items.length >= 2) {
      subs[key] = items.map(function (it) {
        var rest = it.parts.slice(1).map(function (p) { return p.trim(); }).join(' | ').trim();
        return { id: it.g.id, title: rest || key };
      });
    } else {
      items.forEach(function (it) { others.push(it.g); });
    }
  });
  if (others.length) subs.OTHER = (subs.OTHER || []).concat(others);
  Object.keys(subs).forEach(function (key) {
    subs[key].sort(function (a, b) {
      var x = a.title.toUpperCase(), y = b.title.toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  });
  var keys = order.slice().sort().concat(['OTHER']);
  keys.forEach(function (key) {
    if (subs[key] && !top.some(function (t) { return t.group === key; })) {
      top.push({ id: 'grp:' + key, title: key + ' (' + subs[key].length + ')  >', group: key });
    }
  });
  return { top: top, subs: subs };
}

// server.py live_channels(): one page of channels for a genre.
function liveChannels(genre, page, cb) {
  call({ type: 'itv', action: 'get_ordered_list', genre: genre || '*', p: page || 1,
    sortby: 'number', fav: 0 }, function (err, js) {
    if (err) return cb(err);
    cb(null, pageOf(js, function (x) {
      return { id: String(x.id), number: x.number || '', name: x.name || '',
        logo: absUrl(x.logo), cmd: x.cmd || '' };
    }));
  });
}

// server.py live_link(): channel -> stream URL.
function liveLink(cmd, cb) {
  call({ type: 'itv', action: 'create_link', cmd: cmd, forced_storage: 'undefined', disable_ad: 0 },
    function (err, js) {
      if (err) return cb(err);
      var raw = (js && js.cmd) || '';
      var url = cleanCmd(raw);
      if (!url) return cb('channel has no stream URL');
      cb(null, { url: url, cmd: raw });
    });
}

// ------------------------------------------------------------- dispatcher
// Routes the page's /api/... paths to the functions above. Anything not
// ported yet (live TV, subtitles) returns an error the UI can show.
function route(p, params, cb) {
  var q = params || {};
  switch (p) {
    case '/api/vod/categories': return vodCategories(cb);
    case '/api/vod/list':
      return vodList(q.category || '*', parseInt(q.page || 1, 10), q.search || '', cb);
    case '/api/vod/children':
      return vodChildren(q.movie_id, q.season_id || '0', q.episode_id || '0', cb);
    case '/api/vod/play':
      return vodPlay(q.movie_id, q.season_id || '0', q.episode_id || '0', q.series || '', cb);
    case '/api/adult/unlock':
      return adultUnlock(q.pin, cb);
    case '/api/adult/lock':
      return adultLock(cb);
    case '/api/vod/release':
      return vodRelease(q.url || '', cb);
    case '/api/live/genres':
      return liveGenres(q.group, cb);
    case '/api/live/channels':
      return liveChannels(q.genre || '*', parseInt(q.page || 1, 10), cb);
    case '/api/live/link':
      return liveLink(q.cmd || '', cb);
    default:
      return cb('not available on TV yet: ' + p);
  }
}

function reply(msg) {
  return function (err, data) {
    if (err) return msg.respond({ returnValue: false, errorText: String(err), node: process.version });
    msg.respond({ returnValue: true, data: data, node: process.version });
  };
}

service.register('login', function (msg) {
  login(function (err, info) {
    if (err) return msg.respond({ returnValue: false, errorText: String(err), node: process.version });
    msg.respond({ returnValue: true, status: info.status, node: process.version });
  });
});

service.register('api', function (msg) {
  var p = msg.payload || {};
  route(p.path, p.params, reply(msg));
});
