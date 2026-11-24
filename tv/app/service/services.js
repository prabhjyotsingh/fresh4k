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

// ------------------------------------------------------------- subtitles
// Port of server.py's subtitle code: read the stream's HLS subtitle tracks, merge
// their WebVTT segments, shift timing, and return WebVTT for the TV's <track>.
var url = require('url');
var subCache = {};

// GET a text URL (http or https), following redirects. Callback: (err, text).
function fetchText(target, cb, depth) {
  var lib = /^https:/i.test(target) ? require('https') : http;
  var req = lib.get(target, { headers: { 'User-Agent': cfg.user_agent }, timeout: 20000 }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (depth || 0) < 5) {
      res.resume();
      return fetchText(url.resolve(target, res.headers.location), cb, (depth || 0) + 1);
    }
    if (res.statusCode !== 200) { res.resume(); return cb('HTTP ' + res.statusCode); }
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () { cb(null, body); });
  });
  req.on('timeout', function () { req.abort(); cb('timeout'); });
  req.on('error', function (e) { cb(String(e.message || e)); });
}

// server.py _subs_from_master()
function subsFromMaster(text) {
  var subs = [];
  text.split(/\r?\n/).forEach(function (ln) {
    if (ln.indexOf('TYPE=SUBTITLES') < 0) return;
    var name = /NAME="([^"]*)"/.exec(ln), lang = /LANGUAGE="([^"]*)"/.exec(ln), uri = /URI="([^"]*)"/.exec(ln);
    if (!uri) return;
    var label = (name && name[1]) || (lang && lang[1]) || 'Subtitles';
    subs.push({ name: label, lang: (lang && lang[1]) || '', uri: uri[1] });
  });
  return subs;
}

function tsSecs(m) {
  return (parseInt(m[1] || 0, 10)) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

// server.py _parse_vtt(): cues as [start, end, text], with MPEG-TS offset applied.
function parseVtt(text) {
  var lines = text.split(/\r?\n/), offset = 0, i, m, cues = [];
  for (i = 0; i < Math.min(6, lines.length); i++) {
    m = /X-TIMESTAMP-MAP=.*MPEGTS:(\d+).*LOCAL:(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/.exec(lines[i]);
    if (m) {
      var local = parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60 + parseInt(m[4], 10) + parseInt(m[5], 10) / 1000;
      offset = parseInt(m[1], 10) / 90000 - local;
    }
  }
  var n = lines.length;
  for (i = 0; i < n; i++) {
    if (lines[i].indexOf('-->') < 0) continue;
    var re = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/g, times = [], t;
    while ((t = re.exec(lines[i])) !== null) times.push(t);
    if (times.length < 2) continue;
    var start = tsSecs(times[0]) + offset, end = tsSecs(times[1]) + offset;
    var txt = [];
    i++;
    while (i < n && lines[i].trim() !== '') { txt.push(lines[i].replace(/<[^>]+>/g, '')); i++; }
    if (txt.length) cues.push([Math.max(0, start), Math.max(0, end), txt.join('\n')]);
  }
  return cues;
}

// Run fn(item, done) over items, at most 8 at a time. cb(results) when all are done.
function fetchAll(items, fn, cb) {
  var results = new Array(items.length), next = 0, active = 0, done = 0;
  if (!items.length) return cb(results);
  (function pump() {
    while (active < 16 && next < items.length) {
      (function (i) {
        active++;
        fn(items[i], function (r) {
          results[i] = r;
          active--;
          done++;
          if (done === items.length) cb(results); else pump();
        });
      })(next++);
    }
  })();
}

// All cues of one subtitle track. Loads once: callers that ask while a load is
// running wait for the same result instead of downloading the segments again.
var subWaiting = {};
function subtitleCues(streamUrl, track, cb) {
  var key = streamUrl.split('?')[0] + '|' + track;
  if (subCache[key]) return cb(null, subCache[key]);
  if (subWaiting[key]) return subWaiting[key].push(cb);
  subWaiting[key] = [cb];
  loadCues(streamUrl, track, function (err, cues) {
    var waiting = subWaiting[key] || [];
    delete subWaiting[key];
    if (!err) subCache[key] = cues;
    waiting.forEach(function (f) { f(err, cues); });
  });
}

// server.py _subtitle_cues(): fetch and merge one track's segments (no caching here).
function loadCues(streamUrl, track, cb) {
  fetchText(streamUrl, function (err, text) {
    if (err) return cb(err);
    var subs = subsFromMaster(text);
    if (!subs.length) return cb(null, []);
    var chosen = null;                           // first track matching the name/lang, else the first
    for (var j = 0; j < subs.length && !chosen; j++) {
      if (track === '' || track === subs[j].name || track === subs[j].lang) chosen = subs[j];
    }
    chosen = chosen || subs[0];
    var base = streamUrl.slice(0, streamUrl.lastIndexOf('/') + 1);
    var plUrl = url.resolve(base, chosen.uri);
    fetchText(plUrl, function (err2, pl) {
      if (err2) return cb(err2);
      var segBase = plUrl.slice(0, plUrl.lastIndexOf('/') + 1);
      var segs = pl.split(/\r?\n/).filter(function (l) { return l && l.charAt(0) !== '#'; })
        .map(function (l) { return url.resolve(segBase, l); });
      fetchAll(segs, function (u, done) {
        fetchText(u, function (e, t) { done(e ? [] : parseVtt(t)); });
      }, function (parts) {
        var cues = [];
        parts.forEach(function (p) { cues = cues.concat(p); });
        cb(null, cues);            // subtitleCues() caches the result
      });
    });
  });
}

// WebVTT text from cues, shifted by `shift` seconds. Same de-duplication as server.py _srt().
function toVtt(cues, shift) {
  var sorted = cues.slice().sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
  var seen = {}, uniq = [];
  sorted.forEach(function (c) {
    var a = Math.max(0, c[0] + (shift || 0)), b = Math.max(0, c[1] + (shift || 0));
    var k = a.toFixed(2) + '|' + b.toFixed(2) + '|' + c[2];
    if (!seen[k]) { seen[k] = true; uniq.push([a, b, c[2]]); }
  });
  function ts(t) {
    var ms = Math.round(t * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + '.' + p(ms, 3);
  }
  return 'WEBVTT\n\n' + uniq.map(function (c) {
    return ts(c[0]) + ' --> ' + ts(c[1]) + '\n' + c[2] + '\n';
  }).join('\n');
}

// server.py vod_subs(): subtitle track names for the menu. Errors give an empty list.
function vodSubs(streamUrl, cb) {
  fetchText(streamUrl, function (err, text) {
    if (err) return cb(null, []);
    var subs = subsFromMaster(text);
    // Start loading the first track now (in the background), so Green opens fast.
    if (subs.length) subtitleCues(streamUrl, subs[0].name, function () {});
    cb(null, subs.map(function (s) { return { name: s.name, lang: s.lang }; }));
  });
}

// server.py vod_subtitle_srt(), returned as WebVTT: { vtt: "..." }.
function vodSubtitle(streamUrl, track, shift, cb) {
  subtitleCues(streamUrl, track || '', function (err, cues) {
    if (err) return cb(err);
    cb(null, { vtt: toVtt(cues, shift) });
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
    case '/api/vod/subs':
      return vodSubs(q.url || '', cb);
    case '/api/vod/subtitle':
      return vodSubtitle(q.url || '', q.track || '', parseFloat(q.shift) || 0, cb);
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
