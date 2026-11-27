/* fresh4k mini portal UI — ES5 only (MAG browsers are old WebKit). */
(function () {
  'use strict';

  // Canonical key codes. Values measured on a MAG544w3 remote; see normKey().
  var K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13,
    BACK: 27,                     // remote Back (= Esc). Desktop Backspace also maps here.
    PGUP: 33, PGDN: 34,           // CH+ (Tab) / CH- (Shift+Tab); PageUp/PageDown on desktop
    PLAY: 82, STOP: 83,           // Alt+R / Alt+S on MAG
    REW: 66, FFWD: 70,            // Alt+B / Alt+F on MAG
    INFO: 89,                     // Alt+P on MAG
    BLUE: 115,                    // Ctrl+F4 on MAG, F4 on desktop
    RED: 112,                     // Ctrl+F1 on MAG: reloads the portal
    GREEN: 113,                   // Ctrl+F2 on MAG: audio & subtitles while playing
    YELLOW: 114                   // Ctrl+F3 on MAG: remove from Continue watching
  };

  var TABS = [
    { id: 'home', title: 'Home' },
    { id: 'vod', title: 'Movies & Series' },
    { id: 'live', title: 'Live TV' },
    { id: 'search', title: 'Search' },
    { id: 'mine', title: 'My List' }
  ];

  var MAG = !!window.gSTB;            // MAG box: old WebKit, native player behind the page
  var TV = !!window.fkTransport;      // LG webOS build (tv/app/transport.js)
  var FX = !MAG;                      // transitions and transforms for scrolling: fine on the TV, not on the box
  var LBL = window.fkLabels || {};    // the TV's names for remote buttons
  var BACK = LBL.back || 'BACK';

  // Geometry. Keep in step with app.css.
  var LAYOUT = {
    vod: { cols: 6, pitch: 276, rows: 2, unit: 'title' },      // poster grid: two full rows on screen
    live: { cols: 3, pitch: 79, rows: 7, unit: 'channel' }     // channel list
  };
  var CARD_W = 166;                   // Home: card width + gap
  var ROW_H = 316;                    // Home: height of one row (title + cards)
  var ROW_SLOTS = 5;                  // Home: the focused card sits at most this many cards from the left
  var MIN_RESUME = 30;                // seconds watched before a title counts as started

  var S = {
    zone: 'home', tab: 0, tabFocus: 0, cats: [], cat: 0, catFocus: 0, catTok: 0,
    grid: { items: [], idx: 0, top: 0, cols: 6, kind: 'vod', src: null, key: '', opt: {}, page: 0, total: 0, done: true, loading: false, tok: 0 },
    home: { rows: [], r: 0, tok: 0, ready: false, touched: false, err: null },
    memo: {}, memoKeys: [],           // where you were in the lists you left (see stashGrid)
    last: {},                         // tab id -> the category you had open there
    detail: null, flags: {}, adultOpen: false
  };

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function noop() {}
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }      // 1204 -> 1,204
  function pct(f) { return Math.max(0, Math.min(100, Math.round(100 * f))); }
  function dur(min) {                                                               // 112 -> "1 h 52 min"
    min = parseInt(min, 10);
    if (!(min > 0)) return '';
    var h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function qs(params) {
    var out = [];
    for (var k in params) if (params.hasOwnProperty(k)) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return out.join('&');
  }
  function cls(el, name, on) {                       // add or remove one class
    if (!el) return;
    var c = trim((' ' + el.className + ' ').replace(' ' + name + ' ', ' '));
    el.className = on ? (c ? c + ' ' + name : name) : c;
  }
  // Move a scrolling layer. The TV animates a transform; the MAG just repositions it.
  function shift(el, x, y) {
    if (!el) return;
    if (FX) {
      var t = 'translate3d(' + x + 'px,' + y + 'px,0)';
      el.style.webkitTransform = t;
      el.style.transform = t;
    } else {
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }
  }
  function shiftNow(el, x, y) {                      // the same, without the slide
    if (!el) return;
    if (!FX) return shift(el, x, y);
    el.style.transition = 'none';
    shift(el, x, y);
    void el.offsetHeight;                            // flush, so the jump is not animated
    el.style.transition = '';
  }
  // Small spinner by the clock while any request is pending (not in the middle of the screen).
  var pending = 0;
  function busy(on) { pending = Math.max(0, pending + (on ? 1 : -1)); setFlag('busy', pending > 0); }

  // Lists are kept for a few minutes, so going back to a tab or a category is instant.
  var TTL = { '/api/vod/categories': 600, '/api/live/genres': 600, '/api/vod/list': 300,
    '/api/vod/children': 300, '/api/live/channels': 300 };
  var cache = {}, cacheKeys = [];
  function api(path, params, cb) {
    var ttl = TTL[path], key = ttl ? path + '?' + qs(params || {}) : '', hit = key && cache[key];
    if (hit && hit.exp > Date.now()) { setTimeout(function () { cb(null, hit.data); }, 0); return; }
    busy(true);
    apiRaw(path, params, function (err, data) {
      busy(false);
      if (!err && key) {
        if (!cache[key]) cacheKeys.push(key);
        cache[key] = { exp: Date.now() + ttl * 1000, data: data };
        if (cacheKeys.length > 80) delete cache[cacheKeys.shift()];
      }
      cb(err, data);
    });
  }
  function dropCache() { cache = {}; cacheKeys = []; S.memo = {}; S.memoKeys = []; S.home.ready = false; }
  function apiRaw(path, params, cb) {
    if (window.fkTransport) return fkTransport.api(path, params || {}, cb);   // TV build only
    var x = new XMLHttpRequest();
    x.open('GET', path + '?' + qs(params || {}), true);
    x.timeout = 30000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
      if (x.status !== 200 || !data) return cb((data && data.error) || (x.status ? 'Server error ' + x.status : 'Server not reachable'));
      cb(null, data);
    };
    x.send();
  }
  // Favorites / resume points are stored on the server (state.json) so they survive box reboots.
  var STATE = (function () {
    if (window.fkTransport) return fkTransport.state();                        // TV build only
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/state', false);
      x.send();
      return JSON.parse(x.responseText) || {};
    } catch (e) { return {}; }
  })();
  var lookup = {};                                   // per-key indexes over STATE, rebuilt after a save
  function load(key, dflt) {
    return STATE.hasOwnProperty(key) ? JSON.parse(JSON.stringify(STATE[key])) : dflt;
  }
  function save(key, v) {
    STATE[key] = v;
    lookup = {};
    var body = {}; body[key] = v;
    if (window.fkTransport) return fkTransport.saveState(body);                // TV build only
    var x = new XMLHttpRequest();
    x.open('POST', '/api/state', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(body));
  }
  function ensureVisible(box, el, padPx) {
    if (!el) return;
    padPx = padPx || 0;
    var top = el.offsetTop, bottom = top + el.offsetHeight;
    if (top - padPx < box.scrollTop) box.scrollTop = Math.max(0, top - padPx);
    else if (bottom + padPx > box.scrollTop + box.clientHeight) box.scrollTop = bottom + padPx - box.clientHeight;
  }

  var toastTimer;
  function toast(msg, sticky) {
    var t = $('toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    t.className = 'on';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, 2600);
  }
  function hideToast() { clearTimeout(toastTimer); $('toast').className = ''; }

  function setFlag(name, on) {
    on = !!on;
    if (!!S.flags[name] === on) return;
    S.flags[name] = on;
    bodyClass();
  }
  function bodyClass() {
    var c = ['tab-' + TABS[S.tab].id, 'z-' + S.zone];
    for (var f in S.flags) if (S.flags[f]) c.push(f);
    c.push(MAG ? 'mag' : 'desktop fx');
    if (TV) c.push('tv');
    c = c.join(' ');
    if (document.body.className !== c) document.body.className = c;
  }
  function setZone(z) {
    if (window.fkTransport && z !== S.zone) fkTransport.zone(z);     // TV build only: history for Back
    S.zone = z;
    bodyClass();
    var input = z === 'search' ? $('search') : z === 'find' ? $('find') : z === 'pin' ? $('pin') : null;
    if (input) {
      input.focus();                             // MAG: CSS docks the field low; the keyboard follows it
      try { if (MAG && gSTB.ShowVirtualKeyboard) gSTB.ShowVirtualKeyboard(); } catch (e) { /* n/a */ }
    } else {
      var a = document.activeElement;
      if (a && (a.id === 'search' || a.id === 'find' || a.id === 'pin')) {
        a.blur();
        try { if (MAG && gSTB.HideVirtualKeyboard) gSTB.HideVirtualKeyboard(); } catch (e) { /* n/a */ }
      }
    }
    drawCount();
    drawHint();
  }

  // Backdrop colour from a poster: draw it into a tiny canvas and let the browser
  // stretch that over the screen. The stretch blurs it, at no cost per frame.
  // `ready` is the poster's <img> when it is already on screen (no second download).
  function ambient(cv, url, ready) {
    if (!cv || !cv.getContext || cv.fkUrl === url) return;
    cv.fkUrl = url;
    cv.className = '';
    if (!url) return;
    if (ready) return paintAmbient(cv, ready);
    var im = new Image();
    im.onload = function () { if (cv.fkUrl === url) paintAmbient(cv, im); };   // unless focus moved on meanwhile
    im.src = url;
  }
  function paintAmbient(cv, im) {
    var c;
    try {
      var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height, band = Math.min(h, w * cv.height / cv.width);
      c = cv.getContext('2d');
      c.drawImage(im, 0, (h - band) * 0.3, w, band, 0, 0, cv.width, cv.height);
      cv.className = 'on';
    } catch (e) { return; }                      // no canvas: the plain background stays
    try {                                        // soften it: the canvas over itself, a pixel each way
      c.globalAlpha = 0.5;
      for (var p = 0; p < 2; p++) { c.drawImage(cv, 1, 0); c.drawImage(cv, -1, 0); c.drawImage(cv, 0, 1); c.drawImage(cv, 0, -1); }
      c.globalAlpha = 1;
    } catch (e2) { /* the unsoftened picture is fine */ }
  }
  function loadedImg(tileId, url) {              // the tile's poster <img>, if it has finished loading
    var el = $(tileId), im = el && el.getElementsByTagName('img')[0];
    return im && im.complete && im.naturalWidth && im.getAttribute('src') === url ? im : null;
  }

  // ---------------------------------------------------------------- hints
  function kb(name, text) { return '<span><b class="k">' + esc(name) + '</b>' + esc(text) + '</span>'; }
  function kc(color, text) { return '<span><b class="dot ' + color + '"></b>' + esc(text) + '</span>'; }
  function drawHint() {
    var z = S.zone, tab = TABS[S.tab].id, g = S.grid, h = '';
    if (z === 'tabs') h = kb('◄ ►', 'Switch') + kb('▼', 'Open') + kc('red', 'Reload');
    else if (z === 'home') {
      var row = S.home.rows[S.home.r];
      if (!row || !row.items.length) h = kb('▲', 'Menu') + kc('red', 'Reload');
      else if (row.kind === 'cont') {
        var e = recentFor(row.items[row.idx].id);
        h = kb('OK', e && e.pos > 0 ? 'Resume' : 'Play') + kb('INFO', 'Details') + kc('yellow', 'Remove') + kc('blue', 'My List');
      }
      else h = kb('OK', 'Details') + kb('PLAY', 'Play now') + kc('blue', 'My List');
    }
    else if (z === 'cats') h = kb('OK', 'Open') + kb('CH', 'Page') + kb(BACK, 'Menu');
    else if (z === 'grid') {
      if (!g.items.length) h = kb(BACK, 'Back');
      else if (g.kind === 'live') h = kb('OK', 'Watch') + kb('CH', 'Page') + kb(BACK, 'Back');
      else {
        h = kb('OK', 'Details') + kb('PLAY', 'Play now') + kc('blue', 'My List');
        if (tab === 'mine' && S.cats[S.cat] && S.cats[S.cat].id === 'recent') h += kc('yellow', 'Remove');
        if (S.flags.cansearch) h += kb('▲', 'Search here');
        h += kb('CH', 'Page');
      }
    }
    else if (z === 'search' || z === 'find') h = kb('▼', 'Results') + kb(BACK, z === 'find' ? 'Clear' : 'Menu');
    else if (z === 'detail') h = kb('OK', 'Select') + kc('blue', 'My List') + kb(BACK, 'Back');
    else if (z === 'starting') h = '';
    $('hint').innerHTML = h;
  }

  // ------------------------------------------------------- favorites/progress
  // favs: [vodItem]
  // resume: {key: {pos, len}}
  // recent: [{item, key, label, ref, pos, len, sname}], newest first. pos 0 = the next episode, not started.
  // seen: [{id: seriesId, eps: {episodeId: 1}}], newest first
  // searches: [text], newest first
  function favs() { return load('favs', []); }
  function byId(key) {                                // {id: entry} over STATE[key], for the many lookups a redraw makes
    if (!lookup[key]) {
      var m = lookup[key] = {}, list = STATE[key] || [];
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i], id = e && (e.item ? e.item.id : e.id);
        if (id != null) m[id] = e;
      }
    }
    return lookup[key];
  }
  function isFav(it) { return !!byId('favs')[it.id]; }
  function shownFavs() {                              // adult titles stay out while the lock is on
    var f = favs(), out = [];
    for (var i = 0; i < f.length; i++) if (!f[i].adult || S.adultOpen) out.push(f[i]);
    return out;
  }
  function toggleFav(it) {
    var f = favs(), had = false;
    for (var i = 0; i < f.length; i++) if (f[i].id === it.id) { f.splice(i, 1); had = true; break; }
    if (!had) f.unshift(it);
    save('favs', f);
    toast(had ? 'Removed from My List' : 'Added to My List');
    return !had;
  }
  function resumeOf(key) { return (STATE.resume || {})[key]; }
  function recentFor(id) { return byId('recent')[id] || null; }     // read-only: this is the stored entry
  function contItems() {
    var r = load('recent', []), out = [];
    for (var j = 0; j < r.length; j++) if (r[j] && r[j].item && !r[j].item.adult) out.push(r[j].item);
    return out;
  }
  function pruneResume(recent) {                      // keep only the resume points still in Continue watching
    var resume = load('resume', {}), keep = {}, k;
    for (var j = 0; j < recent.length; j++) keep[recent[j].key] = 1;
    for (k in resume) if (!keep[k]) delete resume[k];
    return resume;
  }
  // Returns true when the title was watched to the end.
  function saveProgress(o, pos, len) {
    if (!o || !o.key || !(pos > 0) || (o.item && o.item.adult)) return false;   // adult titles never go in Continue watching
    var recent = load('recent', []), done = len > 0 && pos / len > 0.95;
    if (!done && pos < MIN_RESUME) return false;  // opened and closed again: not worth a place in the list
    for (var i = 0; i < recent.length; i++) if (recent[i].item.id === o.item.id) { recent.splice(i, 1); break; }
    if (!done) recent.unshift({ item: o.item, key: o.key, label: o.label, ref: o.ref, pos: pos, len: len, sname: o.sname });
    recent = recent.slice(0, 20);                 // keep the 20 most recent
    var resume = pruneResume(recent);
    if (done) delete resume[o.key];
    else resume[o.key] = { pos: pos, len: len };
    save('resume', resume);
    save('recent', recent);
    if (done && o.ref && o.ref.episode_id) markSeen(o.item.id, o.ref.episode_id);
    return done;
  }
  function removeRecent(id) {
    var recent = load('recent', []), out = [];
    for (var i = 0; i < recent.length; i++) if (recent[i].item.id !== id) out.push(recent[i]);
    save('resume', pruneResume(out));
    save('recent', out);
    toast('Removed from Continue watching');
  }
  // A finished episode leaves its series in Continue watching, pointing at the next one.
  function pointRecent(n) {
    if (!n || n.item.adult) return;
    var recent = load('recent', []);
    for (var i = 0; i < recent.length; i++) {
      if (recent[i].item.id !== n.item.id) continue;
      if (recent[i].pos > 0) return;              // already watching something of it: leave that alone
      recent.splice(i, 1);
      break;
    }
    recent.unshift({ item: n.item, key: n.key, label: n.label, ref: n.ref, pos: 0, len: 0, sname: n.sname });
    recent = recent.slice(0, 20);
    save('resume', pruneResume(recent));
    save('recent', recent);
  }
  function seenOf(seriesId) { var e = byId('seen')[seriesId]; return (e && e.eps) || {}; }
  function markSeen(seriesId, episodeId) {
    var seen = load('seen', []), entry = null;
    for (var i = 0; i < seen.length; i++) if (seen[i].id === seriesId) { entry = seen.splice(i, 1)[0]; break; }
    entry = entry || { id: seriesId, eps: {} };
    entry.eps[episodeId] = 1;
    seen.unshift(entry);
    save('seen', seen.slice(0, 40));
  }
  function leftText(r) {                              // "42 min left", or "Up next" for an episode not started
    if (!r || !(r.pos > 0) || !(r.len > 0)) return 'Up next';
    return dur(Math.max(1, Math.ceil((r.len - r.pos) / 60))) + ' left';
  }
  function epShort(label) {                           // "Season 1 · Episode 5" -> "S1 · E5", to fit under a card
    return String(label || '').replace(/Season\s*(\d+)/i, 'S$1').replace(/Episode\s*(\d+)/i, 'E$1');
  }
  function rating(it) { return parseFloat(it.rating) > 0 ? it.rating : ''; }
  function metaHtml(it, noKind) {
    var m = [];
    if (it.year) m.push(esc(it.year));
    if (rating(it)) m.push('<span class="r">★ ' + esc(rating(it)) + '</span>');
    if (it.is_series) { if (!noKind) m.push('Series'); }
    else if (dur(it.time)) m.push(dur(it.time));
    if (it.genres) m.push(esc(it.genres));
    return m.join(' &nbsp;·&nbsp; ');
  }

  // ---------------------------------------------------------------- tabs
  function drawTabs() {
    var h = '';
    for (var i = 0; i < TABS.length; i++) {
      h += '<span class="tab' + (i === S.tab ? ' sel' : '') + (i === S.tabFocus ? ' focus' : '') + '">' +
        esc(TABS[i].title) + '<i></i></span>';
    }
    $('tabs').innerHTML = h;
  }

  function selectTab(i) {
    S.tab = S.tabFocus = i;
    drawTabs();
    S.flags.cansearch = S.flags.scoped = false;
    bodyClass();
    var id = TABS[i].id;
    S.catTok++;
    clearTimeout(catTimer);
    if (id === 'home') showHome();
    else if (id === 'vod') loadCats('/api/vod/categories');
    else if (id === 'live') loadCats('/api/live/genres');
    else if (id === 'mine') setCats([{ id: 'favs', title: 'My List' }, { id: 'recent', title: 'Continue watching' }]);
    else if (id === 'search') {
      setCats(searchCats(), true);
      var q = trim($('search').value);
      if (q.length >= 2) runSearch(q); else searchIdle();
    }
    drawHint();
  }

  function tabsKey(k) {
    if (k === K.LEFT && S.tabFocus > 0) { selectTab(S.tabFocus - 1); }
    else if (k === K.RIGHT && S.tabFocus < TABS.length - 1) { selectTab(S.tabFocus + 1); }
    else if (k === K.DOWN || k === K.OK) {
      var id = TABS[S.tab].id;
      if (id === 'home') setZone('home');
      else if (id === 'search') setZone('search');
      else if (S.cats.length) setZone('cats');
      else if (S.grid.items.length) setZone('grid');
    }
  }

  // ------------------------------------------------------------------ home
  // Rows of cards under a large view of the focused title:
  //   Continue watching, My List, then the first group of categories from the menu.
  function localRows() {
    var rows = [], c = contItems(), f = shownFavs();
    if (c.length) rows.push({ id: 'cont', kind: 'cont', title: 'Continue watching', items: c, idx: 0, off: 0, done: true });
    if (f.length) rows.push({ id: 'favs', kind: 'favs', title: 'My List', items: f, idx: 0, off: 0, done: true });
    return rows;
  }
  // The first section of the Movies & Series menu (your picks, when the menu is grouped);
  // the first eight categories when it has no sections.
  function homeCats(cats) {
    var out = [], heads = 0;
    for (var i = 0; i < cats.length && out.length < 14; i++) {
      if (cats[i].header) { if (++heads > 1) break; continue; }
      if (!cats[i].adult) out.push(cats[i]);
    }
    return heads ? out : out.slice(0, 8);
  }
  function showHome() {
    var h = S.home;
    if (h.ready) return homeRefresh();
    var tok = S.catTok;
    h.tok++;
    h.rows = localRows(); h.r = 0; h.err = null; h.touched = false;
    drawHome();
    api('/api/vod/categories', {}, function (err, cats) {
      if (tok !== S.catTok) return;
      if (err) { h.err = err; drawHome(); return; }
      noteAdult(cats);
      var picks = homeCats(cats);
      for (var i = 0; i < picks.length; i++) {
        h.rows.push({ id: 'c' + picks[i].id, kind: 'cat', title: picks[i].title, cat: picks[i].id,
          items: [], idx: 0, off: 0, page: 0, total: 0, done: false, loading: false });
      }
      h.ready = true;
      homeRefresh();                                  // keeps the cursor if you already moved
    });
  }
  function rowReady(row) { return !!(row && row.items.length); }
  function rowIndex(row) {
    for (var i = 0; i < S.home.rows.length; i++) if (S.home.rows[i] === row) return i;
    return -1;
  }
  function cardsHtml(row, n, from, loaded) {
    var h = '';
    for (var i = from; i < row.items.length; i++) h += tileHtml(row.items[i], 'h' + n + '_' + i, 'vod', row.kind, loaded);
    return h;
  }
  function skeleton(kind, count) {
    var h = '';
    for (var i = 0; i < count; i++) {
      h += kind === 'live' ? '<div class="tile ch sk"></div>'
        : '<div class="tile sk"><div class="poster"></div><div class="name"></div></div>';
    }
    return h;
  }
  function drawHome() {
    var h = S.home, html = '', n;
    for (n = 0; n < h.rows.length; n++) {
      var row = h.rows[n];
      html += '<div class="row" id="r' + n + '"><div class="row-t">' + esc(row.title) + '</div><div class="strip">' +
        '<div class="strip-in" id="s' + n + '">' + (row.items.length ? cardsHtml(row, n, 0, true) : skeleton('vod', 8)) +
        '</div></div></div>';
    }
    if (!h.rows.length) {
      html = h.err ? '<div class="row-msg"><b>Could not reach the portal</b>' + esc(h.err) + '</div>'
        : '<div class="row"><div class="row-t"></div><div class="strip"><div class="strip-in">' + skeleton('vod', 8) + '</div></div></div>';
    }
    $('rows-in').innerHTML = html;
    if (h.r >= h.rows.length) h.r = Math.max(0, h.rows.length - 1);
    for (n = 0; n < h.rows.length; n++) if (h.rows[n].off) shiftNow($('s' + n), -h.rows[n].off, 0);
    homeSettle();
  }
  // Put the focus on a row that has cards, and load the rows around it.
  function homeSettle() {
    var h = S.home, r = h.r, i;
    if (!h.touched) r = 0;                            // until you move, focus belongs on the first row with cards
    if (!rowReady(h.rows[r])) {
      for (i = r + 1; i < h.rows.length && !rowReady(h.rows[r]); i++) if (rowReady(h.rows[i])) r = i;
      for (i = r - 1; i >= 0 && !rowReady(h.rows[r]); i--) if (rowReady(h.rows[i])) r = i;
    }
    homeFocus(r, null, true);
  }
  // Fill the focused row and the two below it, one request at a time (easy on the portal and the box).
  function homeLoadNear() {
    var h = S.home, n;
    for (n = 0; n < h.rows.length; n++) if (h.rows[n].loading) return;
    for (n = h.r; n < h.rows.length && n < h.r + 3; n++) {
      var row = h.rows[n];
      if (row.kind === 'cat' && !row.items.length && !row.done && !(row.retryAt > Date.now())) return rowLoad(row);
    }
  }
  function rowLoad(row) {
    if (row.loading || row.done) return;
    row.loading = true;
    var tok = S.home.tok;
    api('/api/vod/list', { category: row.cat, page: row.page + 1 }, function (err, res) {
      if (tok !== S.home.tok) return;                 // Home was rebuilt meanwhile
      row.loading = false;
      var got = (!err && res && res.items) || [];
      if (err) {                                      // stays a placeholder; asked again when you next come near
        row.retryAt = Date.now() + 8000;
        return homeLoadNear();
      }
      if (!got.length) {
        row.done = true;
        if (!row.items.length) homeDrop(row);         // nothing to show: no empty row
        return homeLoadNear();
      }
      var start = row.items.length;
      row.page++;
      row.items = row.items.concat(got);
      row.total = res.total || 0;
      if (row.items.length >= row.total) row.done = true;
      var n = rowIndex(row), el = $('s' + n);
      if (n < 0 || !el || TABS[S.tab].id !== 'home') return;
      if (!start) el.innerHTML = cardsHtml(row, n, 0);
      else {
        var div = document.createElement('div');
        div.innerHTML = cardsHtml(row, n, start);
        while (div.firstChild) el.appendChild(div.firstChild);
      }
      if (!start && (n === S.home.r || !rowReady(S.home.rows[S.home.r]) || !S.home.touched)) homeSettle();
      else homeLoadNear();
    });
  }
  function homeDrop(row) {
    var h = S.home, n = rowIndex(row);
    if (n < 0) return;
    h.rows.splice(n, 1);
    if (n < h.r) h.r--;
    if (TABS[S.tab].id === 'home') drawHome();
  }
  // Rebuild the two personal rows (they change when you watch or edit My List); keep the rest and the focus.
  function homeRefresh() {
    var h = S.home, cur = h.rows[h.r], curId = cur && cur.id, old = {}, i, j;
    for (i = 0; i < h.rows.length; i++) old[h.rows[i].id] = h.rows[i];
    var rows = localRows();
    for (i = 0; i < rows.length; i++) {
      var o = old[rows[i].id], was = o && o.items[o.idx];
      if (!o) continue;
      rows[i].idx = Math.min(o.idx, rows[i].items.length - 1);
      rows[i].off = o.off;
      for (j = 0; was && j < rows[i].items.length; j++) if (rows[i].items[j].id === was.id) rows[i].idx = j;   // follow the title
    }
    for (i = 0; i < h.rows.length; i++) if (h.rows[i].kind === 'cat') rows.push(h.rows[i]);
    h.rows = rows;
    h.r = 0;
    for (i = 0; i < rows.length; i++) if (rows[i].id === curId) h.r = i;
    drawHome();
  }
  var heroTimer;
  function homeFocus(r, i, now) {
    var h = S.home, prev = h.rows[h.r], move = now ? shiftNow : shift;
    if (prev) { cls($('h' + h.r + '_' + prev.idx), 'focus', false); cls($('r' + h.r), 'cur', false); }
    h.r = r;
    var row = h.rows[r];
    clearTimeout(heroTimer);
    if (!rowReady(row)) { drawHero(); drawHint(); homeLoadNear(); return; }
    if (i != null) row.idx = i;
    row.idx = Math.max(0, Math.min(row.idx, row.items.length - 1));
    cls($('h' + r + '_' + row.idx), 'focus', true);
    cls($('r' + r), 'cur', true);
    var x = row.idx * CARD_W;                         // keep a card of look-ahead on both sides
    if (x - row.off > ROW_SLOTS * CARD_W) row.off = x - ROW_SLOTS * CARD_W;
    else if (x - row.off < CARD_W) row.off = Math.max(0, x - CARD_W);
    move($('s' + r), -row.off, 0);
    move($('rows-in'), 0, -r * ROW_H);
    if (now) drawHero(); else heroTimer = setTimeout(drawHero, FX ? 90 : 200);   // not on every step of a fast scroll
    homeLoadNear();
    if (row.kind === 'cat' && row.items.length - row.idx <= 7) rowLoad(row);
    drawHint();
  }
  function drawHero() {
    var h = S.home, row = h.rows[h.r], it = rowReady(row) ? row.items[row.idx] : null;
    var r = it && row.kind === 'cont' ? recentFor(it.id) : null;
    $('h-over').innerHTML = it ? esc(row.title) : '';
    $('h-title').innerHTML = it ? esc(it.name) : '';
    $('h-meta').innerHTML = it ? metaHtml(it) : '';
    $('h-desc').innerHTML = it ? esc(it.description) : '';
    $('h-prog').className = r ? (r.pos > 0 && r.len ? 'on' : 'on next') : '';
    if (r) {
      $('h-fill').style.width = (r.len ? pct(r.pos / r.len) : 0) + '%';
      $('h-left').innerHTML = esc((r.label && r.label !== it.name ? r.label + ' · ' : '') + leftText(r));
    }
    ambient($('h-amb'), it ? it.poster : '', it && loadedImg('h' + h.r + '_' + row.idx, it.poster));
  }
  function homeStep(r, dir) {                         // the next row with cards (a row that failed to load is stepped over)
    for (var i = r + dir; i >= 0 && i < S.home.rows.length; i += dir) if (rowReady(S.home.rows[i])) return i;
    return -1;
  }
  function homeKey(k) {
    var h = S.home, row = h.rows[h.r];
    if (!rowReady(row)) {
      if (k === K.UP || k === K.BACK) setZone('tabs');
      return;
    }
    var i = row.idx, n = row.items.length, it = row.items[i];
    h.touched = true;
    if (k === K.LEFT) { if (i > 0) homeFocus(h.r, i - 1); }
    else if (k === K.RIGHT) { if (i + 1 < n) homeFocus(h.r, i + 1); }
    else if (k === K.PGDN) homeFocus(h.r, Math.min(n - 1, i + 6));
    else if (k === K.PGUP) homeFocus(h.r, Math.max(0, i - 6));
    else if (k === K.DOWN) { var dn = homeStep(h.r, 1); if (dn >= 0) homeFocus(dn); }
    else if (k === K.UP) { var up = homeStep(h.r, -1); if (up >= 0) homeFocus(up); else setZone('tabs'); }
    else if (k === K.OK) { if (row.kind === 'cont') quickPlay(it); else openDetail(it); }
    else if (k === K.PLAY) quickPlay(it);
    else if (k === K.INFO) openDetail(it);
    else if (k === K.BLUE) { toggleFav(it); homeRefresh(); }
    else if (k === K.YELLOW && row.kind === 'cont') { removeRecent(it.id); homeRefresh(); }
    else if (k === K.BACK) {                          // first back to the top-left card, then up to the menu
      var top = 0;
      while (top < h.r && !rowReady(h.rows[top])) top++;
      if (h.r === top && i === 0) return setZone('tabs');
      if (h.r !== top) { row.idx = 0; row.off = 0; shift($('s' + h.r), 0, 0); }
      homeFocus(top, 0);
    }
  }

  // ---------------------------------------------------------- categories
  function noteAdult(cats) {                          // the menu's lock row tells us whether adult content is open
    for (var i = 0; i < cats.length; i++) if (cats[i].adult) S.adultOpen = cats[i].adult === 'lock';
  }
  function loadCats(path) {
    var tok = S.catTok;
    setCats([], true);
    $('cats').innerHTML = '<div class="cat sk"></div><div class="cat sk"></div><div class="cat sk"></div><div class="cat sk"></div>';
    setGrid({ kind: TABS[S.tab].id === 'live' ? 'live' : 'vod', wait: true });
    api(path, {}, function (err, data) {
      if (tok !== S.catTok) return;
      if (err) { $('cats').innerHTML = ''; setGrid({ empty: 'Could not load', emptySub: err }); return; }
      setCats(data);
    });
  }

  // Categories may include {header:"..."} dividers that can't be focused.
  function catSelectable(i) { return i >= 0 && i < S.cats.length && !S.cats[i].header; }
  function catStep(from, dir) {                 // next selectable index in a direction, or -1
    var i = from + dir;
    while (i >= 0 && i < S.cats.length && S.cats[i].header) i += dir;
    return catSelectable(i) ? i : -1;
  }
  function catSnap(i) {                          // nearest selectable to i, or -1
    for (var d = 0; d < S.cats.length; d++) {
      if (catSelectable(i + d)) return i + d;
      if (catSelectable(i - d)) return i - d;
    }
    return -1;
  }

  function setCats(cats, quiet) {                // quiet: don't open the first row
    S.cats = cats;
    $('cats').scrollTop = 0;
    noteAdult(cats);
    var first = catSnap(0), last = S.last[TABS[S.tab].id];
    if (cats.length && S.restoreCatIdx != null) {       // keep the cursor where it was (PIN unlock/lock)
      var keep = catSnap(S.restoreCatIdx);
      if (keep >= 0) first = keep;
      S.restoreCatIdx = null;
    } else if (!quiet && last != null) {                // back on this tab: the category you had open
      for (var i = 0; i < cats.length; i++) if (!cats[i].header && !isNav(cats[i]) && cats[i].id === last) first = i;
    }
    S.catFocus = first < 0 ? 0 : first;
    S.cat = quiet ? -1 : S.catFocus;
    drawCats();
    if (quiet) return;
    if (first < 0) setGrid({ empty: 'Nothing here' });
    else if (!cats[first].adult) selectCat(first);
  }

  function drawCats() {
    var h = '';
    for (var i = 0; i < S.cats.length; i++) {
      var c = S.cats[i];
      if (c.header) { h += '<div class="cat-head">' + esc(c.header) + '</div>'; continue; }
      var t = esc(c.title), nav = '';
      // The server marks drill-down rows with ASCII arrows ("ENGLISH (21)  >", "< All groups").
      if (c.group) { t = esc(c.title.replace(/\s*>\s*$/, '')); nav = '<span class="chev">›</span>'; }
      else if (c.back) t = '‹&nbsp; ' + esc(c.title.replace(/^<\s*/, ''));
      h += '<div class="cat' + (nav ? ' nav' : '') + (i === S.cat ? ' sel' : '') + (i === S.catFocus ? ' focus' : '') +
        '" id="c' + i + '">' + t + nav + '</div>';
    }
    $('cats').innerHTML = h;
    ensureVisible($('cats'), $('c' + S.catFocus), 40);
  }
  function focusCat(i) {
    cls($('c' + S.catFocus), 'focus', false);
    S.catFocus = i;
    cls($('c' + i), 'focus', true);
    ensureVisible($('cats'), $('c' + i), 40);
  }

  function selectCat(i) {
    var c = S.cats[i];
    if (!c || c.header) return;
    cls($('c' + S.cat), 'sel', false);
    S.cat = i;
    cls($('c' + i), 'sel', true);
    var tab = TABS[S.tab].id, id = c.id;
    if (c.adult) return adultAction(c.adult);
    if (!isNav(c) && tab !== 'search') S.last[tab] = id;
    S.flags.cansearch = tab === 'vod';
    S.flags.scoped = false;
    bodyClass();
    if (tab === 'vod') {
      S.curCat = c;
      $('find').value = '';
      $('find').placeholder = 'Search in ' + c.title;
      setGrid({ src: remote('/api/vod/list', { category: id }), key: 'vod:' + id, kind: 'vod', title: c.title });
    }
    else if (tab === 'live') {
      if (c.group) return liveDrill(c.group);                     // group row: show its genres
      if (c.back) return liveTop();                               // back row: show the groups
      setGrid({ src: remote('/api/live/channels', { genre: id }), key: 'live:' + id, kind: 'live', title: c.title });
    }
    else if (tab === 'mine') {
      if (id === 'favs') setGrid({ src: local(shownFavs()), kind: 'vod', row: 'favs', title: c.title, empty: 'Your list is empty', emptySub: 'Press the blue button on any title to keep it here' });
      else setGrid({ src: local(contItems()), kind: 'vod', row: 'cont', title: c.title, empty: 'Nothing in progress', emptySub: 'Titles you start watching show up here' });
    }
    else if (tab === 'search') {
      if (c.clear) {
        save('searches', []);
        setCats([], true);
        return setZone('search');
      }
      $('search').value = c.q;
      runSearch(c.q);
    }
    drawHint();
  }

  // Rows that open another list or a prompt instead of a grid: they act on OK, never on focus alone.
  function isNav(c) { return !!(c && (c.group || c.back || c.adult || c.clear)); }

  // Adult rows: "unlock" asks for the PIN, "lock" locks again right away.
  var pinOk = false;
  function adultAction(kind) {
    if (kind === 'lock') {
      api('/api/adult/lock', {}, function (err) {
        if (err) return toast(err);
        toast('Adult content locked');
        dropCache();
        S.restoreCatIdx = S.catFocus;
        selectTab(S.tab);
      });
      return;
    }
    $('pin').value = '';
    $('pin-hint').innerHTML = kb('OK', 'Unlock') + kb(BACK, 'Cancel');
    setZone('pin');
  }
  function leavePin(ok) {                       // back to the menu, as the Back key would do
    pinOk = ok;
    if (window.fkTransport) return fkTransport.back();   // TV: pops the pin's history entry
    pinKey(K.BACK);                                       // MAG: no history to pop
  }
  function pinKey(k) {
    var input = $('pin');
    if (k === K.BACK) {
      var ok = pinOk;
      pinOk = false;
      input.value = '';
      setZone('cats');
      if (ok) { toast('Adult content unlocked'); dropCache(); S.restoreCatIdx = S.catFocus; selectTab(S.tab); }
      return;
    }
    if (k === K.OK) {
      api('/api/adult/unlock', { pin: input.value }, function (err) {
        if (err) { toast(err === 'wrong PIN' ? 'Wrong PIN' : err); input.value = ''; return; }
        leavePin(true);
      });
      return;
    }
    return false;                               // digits go into the PIN field
  }
  // Live TV is two levels: groups (ENGLISH, SPORTS...) then genres.
  function liveDrill(key) {
    var tok = S.catTok;
    api('/api/live/genres', { group: key }, function (err, list) {
      if (tok !== S.catTok) return;
      if (err) return toast(err);
      S.cats = list;
      S.cat = -1;
      S.catFocus = list.length > 1 ? 1 : 0;                       // first genre under the back row
      $('cats').scrollTop = 0;
      drawCats();
      if (list.length > 1 && !isNav(list[1])) selectCat(1);
      else setGrid({ kind: 'live', empty: 'No channels in this group' });
    });
  }
  function liveTop() {
    var tok = S.catTok;
    api('/api/live/genres', {}, function (err, list) {
      if (tok !== S.catTok) return;
      if (err) return toast(err);
      setCats(list);                                              // selects All and loads its channels
    });
  }

  var catTimer;
  // Up to the tabs. Categories you only passed over on the way are not opened:
  // the cursor goes back to the one that is open.
  function leaveCats() {
    clearTimeout(catTimer);
    if (catSelectable(S.cat) && S.cat !== S.catFocus) focusCat(S.cat);
    setZone('tabs');
  }
  function catsKey(k) {
    var n = S.cats.length, f = S.catFocus, c = S.cats[f];
    if (k === K.UP) {
      var p = catStep(f, -1);
      if (p < 0) return leaveCats();
      f = p;
    } else if (k === K.DOWN) {
      var nx = catStep(f, 1);
      if (nx >= 0) f = nx;
    } else if (k === K.PGDN) { var sd = catSnap(Math.min(n - 1, f + 10)); if (sd >= 0) f = sd; }
    else if (k === K.PGUP) { var su = catSnap(Math.max(0, f - 10)); if (su >= 0) f = su; }
    else if (k === K.RIGHT || k === K.OK) {
      clearTimeout(catTimer);
      if (!c || c.header) return;
      if (isNav(c)) { selectCat(f); return; }                     // stay in the list
      if (S.cat !== f) selectCat(f);
      return setZone('grid');
    } else if (k === K.BACK) return leaveCats();
    else return;
    if (f === S.catFocus) return;
    focusCat(f);
    clearTimeout(catTimer);
    catTimer = setTimeout(function () {                           // open it once the cursor rests
      var cur = S.cats[S.catFocus];
      if (cur && !cur.header && S.cat !== S.catFocus && !isNav(cur)) selectCat(S.catFocus);
    }, 400);
  }

  // ------------------------------------------------- in-category search (find)
  function runFind(q, stay) {
    S.flags.scoped = true;
    bodyClass();
    setGrid({ src: remote('/api/vod/list', { category: S.curCat.id, search: q }), kind: 'vod', title: S.curCat.title,
      empty: 'No results for "' + q + '"', emptySub: 'in ' + S.curCat.title });
    if (!stay) setZone('grid');                  // typing live keeps focus in the box
  }
  function clearFind() {                          // drop the scoped search, show the whole category
    S.flags.scoped = false;
    bodyClass();
    $('find').value = '';
    setGrid({ src: remote('/api/vod/list', { category: S.curCat.id }), key: 'vod:' + S.curCat.id, kind: 'vod', title: S.curCat.title });
  }
  function findKey(k) {
    var input = $('find');
    if (k === K.OK) {
      var q = trim(input.value);
      if (q) runFind(q);
    } else if (k === K.DOWN) {
      if (S.grid.items.length) setZone('grid');
    } else if (k === K.UP) {
      setZone('tabs');
    } else if (k === K.BACK) {
      var had = !!input.value || S.flags.scoped;
      if (S.flags.scoped) clearFind();
      input.value = '';
      if (!had) setZone('grid');
    } else {
      return false;                              // let typing through
    }
  }

  // ---------------------------------------------------------------- search
  function searches() { return load('searches', []); }
  function rememberSearch(q) {
    q = trim(q);
    if (q.length < 2) return;
    var s = searches(), out = [q];
    for (var i = 0; i < s.length; i++) if (String(s[i]).toLowerCase() !== q.toLowerCase()) out.push(s[i]);
    save('searches', out.slice(0, 8));
    if (TABS[S.tab].id === 'search' && S.zone !== 'cats') { S.cats = searchCats(); S.cat = -1; S.catFocus = catSnap(0); drawCats(); }
  }
  function searchCats() {                         // the Search tab's side list: what you searched before
    var s = searches(), out = [];
    if (!s.length) return out;
    out.push({ header: 'RECENT' });
    for (var i = 0; i < s.length; i++) out.push({ id: 'q' + i, title: s[i], q: s[i] });
    out.push({ id: 'clear', title: 'Clear recent', clear: true });
    return out;
  }
  function searchIdle() {
    setGrid({ kind: 'vod', empty: 'Search all movies & series', emptySub: 'Type at least 2 letters' });
  }
  function runSearch(q) {
    setGrid({ src: remote('/api/vod/list', { search: q }), kind: 'vod', empty: 'No results for "' + q + '"', emptySub: 'Check the spelling, or try fewer letters' });
  }

  function searchKey(k) {
    var input = $('search');
    if (k === K.OK) {
      var q = trim(input.value);
      if (q) { rememberSearch(q); runSearch(q); setZone('grid'); }
    } else if (k === K.DOWN || k === K.RIGHT && input.selectionStart >= input.value.length) {
      if (S.grid.items.length) setZone('grid');
    } else if (k === K.LEFT && !input.selectionStart && !input.selectionEnd && S.cats.length) {
      setZone('cats');
    } else if (k === K.UP || k === K.BACK) {
      setZone('tabs');
    } else {
      return false; // let typing through
    }
  }

  // ------------------------------------------------------------------ grid
  function remote(path, params) {
    return function (page, cb) {
      var p = {}; for (var k in params) p[k] = params[k];
      p.page = page;
      api(path, p, cb);
    };
  }
  function local(items) {
    return function (page, cb) { cb(null, { items: page === 1 ? items : [], total: items.length }); };
  }
  function emptyHtml(title, sub) {
    return '<div class="empty"><b>' + esc(title || '') + '</b><span>' + esc(sub || '') + '</span></div>';
  }
  function drawCount() {
    var g = S.grid, el = $('l-count');
    if (!el) return;
    if (!g.items.length) { el.innerHTML = ''; return; }
    var total = Math.max(g.total, g.items.length), unit = LAYOUT[g.kind].unit;
    el.innerHTML = S.zone === 'grid' ? num(g.idx + 1) + ' / ' + num(total) : num(total) + ' ' + unit + (total === 1 ? '' : 's');
  }

  // Coming back to a list within ten minutes puts you where you left it.
  function stashGrid() {
    var g = S.grid;
    if (!g.key || g.idx < g.cols) return;         // still on the first row: nothing worth restoring
    if (!S.memo[g.key]) S.memoKeys.push(g.key);
    S.memo[g.key] = { at: Date.now(), items: g.items, idx: g.idx, top: g.top, page: g.page, total: g.total, done: g.done };
    if (S.memoKeys.length > 6) delete S.memo[S.memoKeys.shift()];
  }
  function takeMemo(key) {
    var m = S.memo[key];
    if (!m) return null;
    delete S.memo[key];
    for (var i = 0; i < S.memoKeys.length; i++) if (S.memoKeys[i] === key) { S.memoKeys.splice(i, 1); break; }
    return Date.now() - m.at < 600000 ? m : null;
  }

  // opt: { src, key, kind, row, title, empty, emptySub, wait }
  //   src   - function(page, cb) giving {items, total}; none = just show the empty message
  //   key   - names a list whose position is worth remembering
  //   row   - 'cont': tiles say how much is left instead of year and rating; 'favs': no My List mark
  //   wait  - show placeholders: the real list is on its way
  function setGrid(opt) {
    var g = S.grid, box = $('grid-in');
    stashGrid();
    g.tok++;
    g.items = []; g.idx = 0; g.top = 0; g.page = 0; g.total = 0; g.loading = false; g.err = null;
    g.src = opt.src || null; g.done = !g.src; g.key = opt.key || ''; g.opt = opt;
    g.kind = opt.kind || 'vod'; g.cols = LAYOUT[g.kind].cols;
    $('l-title').innerHTML = esc(opt.title || '');
    shiftNow(box, 0, 0);
    var m = g.key && takeMemo(g.key);
    if (m) {
      g.items = m.items; g.idx = m.idx; g.top = m.top; g.page = m.page; g.total = m.total; g.done = m.done;
      box.innerHTML = '';
      appendTiles(0, true);
      gridScroll(true);
    } else if (g.src || opt.wait) {
      box.innerHTML = skeleton(g.kind, g.cols * LAYOUT[g.kind].rows);
      if (g.src) loadMore();
    } else {
      box.innerHTML = emptyHtml(opt.empty, opt.emptySub);
    }
    drawCount();
    if (S.zone === 'grid') drawHint();
  }

  function loadMore() {
    var g = S.grid;
    if (g.loading || g.done) return;
    g.loading = true;
    var tok = g.tok;
    g.src(g.page + 1, function (err, res) {
      if (tok !== g.tok) return;
      g.loading = false;
      if (err) {                                  // with tiles on screen, the next move down asks again
        if (!g.items.length) { g.done = true; g.err = err; $('grid-in').innerHTML = emptyHtml('Could not load', err + ' · press OK to try again'); }
        return;
      }
      var start = g.items.length, got = res.items || [];
      g.page++;
      g.items = g.items.concat(got);
      g.total = res.total || 0;
      if (!got.length || g.items.length >= g.total) g.done = true;
      if (!g.items.length) {
        if (!g.done) return loadMore();           // a page with every title hidden: try the next
        $('grid-in').innerHTML = emptyHtml(g.opt.empty || 'Nothing here', g.opt.emptySub);
        drawCount();
        return;
      }
      if (!start) $('grid-in').innerHTML = '';    // the placeholders
      appendTiles(start);
      drawCount();
      if (S.zone === 'grid' && !start) drawHint();
      // Pages are short (14): keep one screen of tiles ahead of the cursor.
      if (g.items.length - g.idx <= g.cols * LAYOUT[g.kind].rows) loadMore();
    });
  }

  function tileHtml(it, id, kind, row, loaded) {
    var name = esc(it.name);
    if (kind === 'live') {
      return '<div class="tile ch" id="' + id + '"><span class="num">' + esc(it.number) + '</span><span class="logo">' +
        (it.logo ? '<img src="' + esc(it.logo) + '" onerror="this.style.display=\'none\'">' : '') +
        '</span><span class="name">' + name + '</span></div>';
    }
    var r = recentFor(it.id), sub = [], prog = '';
    if (r && r.len) prog = '<div class="prog"><i style="width:' + pct(r.pos / r.len) + '%"></i></div>';
    if (row === 'cont' && r) {
      if (r.label && r.label !== it.name) sub.push(esc(epShort(r.label)));
      sub.push(leftText(r));
    } else {
      if (it.is_series) sub.push('Series');
      if (it.year) sub.push(esc(it.year));
      if (rating(it)) sub.push('★ ' + esc(rating(it)));
    }
    return '<div class="tile" id="' + id + '"><div class="poster"><span class="ph">' + name + '</span>' +
      (it.poster ? '<img' + (loaded ? ' class="ld"' : '') + ' src="' + esc(it.poster) +
        '" onload="this.className=\'ld\'" onerror="this.style.display=\'none\'">' : '') +
      (it.warn ? '<span class="warn">' + esc(it.warn) + '</span>' : '') +
      (row !== 'favs' && isFav(it) ? '<span class="favd">✓</span>' : '') + prog +
      '</div><div class="name">' + name + '</div><div class="sub">' + sub.join(' · ') + '</div></div>';
  }

  function appendTiles(start, loaded) {
    var g = S.grid, h = '';
    for (var i = start; i < g.items.length; i++) h += tileHtml(g.items[i], 't' + i, g.kind, g.opt.row, loaded);
    var div = document.createElement('div');
    div.innerHTML = h;
    var box = $('grid-in');
    while (div.firstChild) box.appendChild(div.firstChild);
    cls($('t' + g.idx), 'focus', true);
  }

  // Rows stay whole: the list moves a row at a time, never leaving half a poster.
  function gridScroll(now) {
    var g = S.grid, L = LAYOUT[g.kind], row = Math.floor(g.idx / g.cols);
    if (row < g.top) g.top = row;
    else if (row >= g.top + L.rows) g.top = row - L.rows + 1;
    (now ? shiftNow : shift)($('grid-in'), 0, -g.top * L.pitch);
  }

  function focusTile(i) {
    var g = S.grid;
    cls($('t' + g.idx), 'focus', false);
    g.idx = i;
    cls($('t' + i), 'focus', true);
    gridScroll();
    drawCount();
    if (g.items.length - i <= g.cols * (LAYOUT[g.kind].rows + 1)) loadMore();
  }

  function gridKey(k) {
    var g = S.grid, n = g.items.length, i = g.idx, c = g.cols, tab = TABS[S.tab].id;
    if (!n) {
      if (k === K.OK && g.err) return setGrid(g.opt);                // try the failed list again
      if (k === K.BACK && S.flags.scoped) return clearFind();
      if (k === K.BACK && tab === 'search') return setZone('search');
      if (k === K.LEFT || k === K.BACK) leftOfGrid();
      else if (k === K.UP) aboveGrid();
      return;
    }
    if (k === K.LEFT) { if (i % c === 0) return leftOfGrid(); i--; }
    else if (k === K.RIGHT) { if (i + 1 < n) i++; }     // past the end of a row, wrap to the next row's first tile
    else if (k === K.UP) { if (i - c >= 0) i -= c; else return aboveGrid(); }
    else if (k === K.DOWN) { if (i + c < n) i += c; else if (Math.floor(i / c) < Math.floor((n - 1) / c)) i = n - 1; }
    else if (k === K.PGDN) i = Math.min(n - 1, i + c * LAYOUT[g.kind].rows);
    else if (k === K.PGUP) i = Math.max(0, i - c * LAYOUT[g.kind].rows);
    else if (k === K.OK) {
      if (tab === 'search') rememberSearch($('search').value);
      return g.kind === 'live' ? playLive(i) : openDetail(g.items[i]);
    }
    else if (k === K.PLAY) {
      if (tab === 'search') rememberSearch($('search').value);
      return g.kind === 'live' ? playLive(i) : quickPlay(g.items[i]);
    }
    else if (k === K.BLUE && g.kind === 'vod') { toggleFav(g.items[i]); return refreshGrid(); }
    else if (k === K.YELLOW && tab === 'mine' && S.cats[S.cat] && S.cats[S.cat].id === 'recent') {
      removeRecent(g.items[i].id);
      return refreshGrid();
    }
    else if (k === K.BACK) return S.flags.scoped ? clearFind() : tab === 'search' ? setZone('search') : leftOfGrid();
    else return;
    if (i !== g.idx) focusTile(i);
  }

  function leftOfGrid() {
    if (S.cats.length) setZone('cats');
    else if (TABS[S.tab].id === 'search') setZone('search');
    else setZone('tabs');
  }
  function aboveGrid() {
    setZone(S.flags.cansearch ? 'find' : TABS[S.tab].id === 'search' ? 'search' : 'tabs');
  }

  // Redraw the focused tile (progress, My List mark).
  function refreshTile() {
    var g = S.grid, el = $('t' + g.idx);
    if (!el || g.kind !== 'vod' || !g.items[g.idx]) return;
    var div = document.createElement('div');
    div.innerHTML = tileHtml(g.items[g.idx], 't' + g.idx, g.kind, g.opt.row, true);
    var fresh = div.firstChild;
    fresh.className += ' focus';
    el.parentNode.replaceChild(fresh, el);
  }
  // After watching or editing lists: My List's own grids are rebuilt (their order changes), others just redraw a tile.
  function refreshGrid() {
    var g = S.grid, c = S.cats[S.cat];
    if (TABS[S.tab].id !== 'mine' || !c) return refreshTile();
    var cur = g.items[g.idx], at = g.idx;
    selectCat(S.cat);                             // local lists arrive at once
    g = S.grid;
    if (!g.items.length) { if (S.zone === 'grid') leftOfGrid(); return; }
    var i = Math.min(at, g.items.length - 1);
    for (var j = 0; cur && j < g.items.length; j++) if (g.items[j].id === cur.id) i = j;
    focusTile(i);
    gridScroll(true);
  }

  // ---------------------------------------------------------------- detail
  function bySeasonNo(a, b) { return (a.no - b.no) || (a.at - b.at); }
  // Seasons in watching order, episodes by number. Both come from the cache after the first look.
  function seasonsOf(it, cb) {
    api('/api/vod/children', { movie_id: it.id, season_id: 0 }, function (err, res) {
      if (err) return cb(err);
      var raw = res.items || [], list = [];
      for (var i = 0; i < raw.length; i++) {
        var m = /\d+/.exec(raw[i].name || '');
        list.push({ id: raw[i].id, name: raw[i].name, no: m ? +m[0] : 1e6, at: i });
      }
      list.sort(bySeasonNo);
      cb(null, list);
    });
  }
  function seasonEps(it, seasonId, cb) {
    api('/api/vod/children', { movie_id: it.id, season_id: seasonId }, function (err, res) {
      if (err) return cb(err);
      var eps = (res.items || []).slice();
      eps.sort(function (a, b) { return (+a.series_number || 0) - (+b.series_number || 0); });
      cb(null, eps);
    });
  }
  // A play request "o": { item, key (resume key), label, ref (params for /api/vod/play), start, sname }.
  // Episodes started from a season list also carry { season, eps, j } so the next one is known at once.
  function movieReq(it, start) {
    return { item: it, key: it.id, label: it.name, ref: { movie_id: it.id }, start: start || 0 };
  }
  function epReq(it, season, eps, j, start) {
    var e = eps[j];
    return { item: it, key: it.id + ':' + e.id, label: season.name + ' · ' + e.name, sname: season.name, start: start || 0,
      ref: { movie_id: it.id, season_id: season.id, episode_id: e.id, series: e.series_number },
      season: season, eps: eps, j: j };
  }
  function recentReq(r, it) {
    return { item: it || r.item, key: r.key, label: r.label, ref: r.ref, start: r.pos || 0, sname: r.sname };
  }
  // The episode after o, across the end of a season. cb(request) or cb(null).
  function resolveNext(o, cb) {
    var ref = o.ref || {}, it = o.item;
    if (!ref.episode_id) return cb(null);         // a movie
    function nextSeason() {
      seasonsOf(it, function (err, seasons) {
        if (err) return cb(null);
        var s = -1;
        for (var i = 0; i < seasons.length; i++) if (String(seasons[i].id) === String(ref.season_id)) s = i;
        if (s < 0 || s + 1 >= seasons.length) return cb(null);
        seasonEps(it, seasons[s + 1].id, function (err2, eps) {
          cb(err2 || !eps.length ? null : epReq(it, seasons[s + 1], eps, 0, 0));
        });
      });
    }
    if (o.eps) return o.j + 1 < o.eps.length ? cb(epReq(it, o.season, o.eps, o.j + 1, 0)) : nextSeason();
    seasonEps(it, ref.season_id, function (err, eps) {       // resumed from Continue watching: look the season up
      if (err) return cb(null);
      var j = -1;
      for (var i = 0; i < eps.length; i++) if (String(eps[i].id) === String(ref.episode_id)) j = i;
      var season = { id: ref.season_id, name: o.sname || String(o.label || '').split(' · ')[0] };
      if (j >= 0 && j + 1 < eps.length) return cb(epReq(it, season, eps, j + 1, 0));
      nextSeason();
    });
  }
  function firstUnseen(it, eps) {                 // where to start a season: after the last episode watched
    var seen = seenOf(it.id), r = recentFor(it.id), last = -1;
    for (var j = 0; j < eps.length; j++) {
      if (r && r.ref && String(r.ref.episode_id) === String(eps[j].id)) return j;
      if (seen[eps[j].id]) last = j;
    }
    return last + 1 < eps.length ? last + 1 : 0;
  }

  function openDetail(it) {
    var d = S.detail = { item: it, stack: [], list: [], idx: 0, crumb: '', extra: null, rebuild: null,
      back: S.zone === 'home' ? 'home' : 'grid', seasons: null, busy: false };
    var hr = S.home.rows[S.home.r];
    var tile = d.back === 'home' ? (hr ? 'h' + S.home.r + '_' + hr.idx : '') : 't' + S.grid.idx;
    $('d-poster').innerHTML = '<span class="ph">' + esc(it.name) + '</span>' +
      (it.poster ? '<img src="' + esc(it.poster) + '" onerror="this.style.display=\'none\'">' : '');
    $('d-over').innerHTML = (it.is_series ? 'SERIES' : 'MOVIE') + (it.warn ? '<span class="warn">' + esc(it.warn) + '</span>' : '');
    $('d-title').innerHTML = esc(it.name);
    $('d-meta').innerHTML = metaHtml(it, true);
    $('d-desc').innerHTML = esc(it.description);
    $('d-credits').innerHTML = (it.director ? '<div><b>Director</b>' + esc(it.director) + '</div>' : '') +
      (it.actors ? '<div><b>Cast</b>' + esc(it.actors) + '</div>' : '');
    ambient($('d-amb'), it.poster, loadedImg(tile, it.poster));
    S.flags.detail = true; S.flags.dsub = false;
    setZone('detail');
    buildMain();
    if (it.is_series) loadSeasons(d);
  }
  function loadSeasons(d) {
    d.extra = null;
    seasonsOf(d.item, function (err, seasons) {
      if (S.detail !== d) return;
      var acts = [];
      if (err) acts.push({ id: 'retry', label: 'Could not load the episodes', right: 'OK to try again', fn: function () { loadSeasons(d); buildMain(); } });
      else {
        d.seasons = seasons;
        for (var i = 0; i < seasons.length; i++) acts.push(seasonAction(d.item, seasons[i]));
        if (!acts.length) acts.push({ id: 'none', label: 'No episodes found', dead: true, fn: noop });
      }
      d.extra = acts;
      if (!d.stack.length) buildMain();
    });
  }

  // The title's own actions: play / resume, seasons, My List.
  function buildMain() {
    var d = S.detail, it = d.item, list = [], r = recentFor(it.id);
    if (it.is_series) {
      if (r && r.ref) {
        list.push({ id: 'play', label: (r.pos > 0 ? '▶  Resume ' : '▶  Play ') + r.label, right: r.pos > 0 ? leftText(r) : '',
          prog: r.len ? r.pos / r.len : 0, fn: function () { playVod(recentReq(r, it)); } });
      } else {
        list.push({ id: 'play', label: '▶  Play', right: d.seasons && d.seasons.length ? d.seasons[0].name : '',
          fn: function () { startSeries(it); } });
      }
      list = list.concat(d.extra || [{ id: 'wait', label: 'Loading seasons…', dead: true, fn: noop }]);
    } else {
      var res = resumeOf(it.id), resumable = res && res.pos >= MIN_RESUME;
      if (resumable) {
        list.push({ id: 'play', label: '▶  Resume', right: leftText(res), prog: res.len ? res.pos / res.len : 0,
          fn: function () { playVod(movieReq(it, res.pos)); } });
        list.push({ id: 'restart', label: 'Play from the beginning', fn: function () { playVod(movieReq(it, 0)); } });
      } else {
        list.push({ id: 'play', label: '▶  Play', fn: function () { playVod(movieReq(it, 0)); } });
      }
    }
    list.push({ id: 'fav', label: isFav(it) ? '✓  In My List' : '+  Add to My List', fn: function () { toggleFav(it); buildMain(); } });
    if (r) list.push({ id: 'forget', label: '×  Remove from Continue watching', fn: function () { removeRecent(it.id); buildMain(); } });
    setList(list, '');
  }
  function setList(list, crumb) {                 // keep the cursor on the same action when the list is rebuilt
    var d = S.detail, was = d.list[d.idx] && d.list[d.idx].id, idx = Math.min(d.idx, list.length - 1);
    for (var i = 0; i < list.length; i++) if (was && list[i].id === was) idx = i;
    d.list = list; d.idx = Math.max(0, idx); d.crumb = crumb;
    drawDetail();
  }

  function seasonAction(it, season) {
    return { id: 's' + season.id, label: season.name, chev: true, fn: function () {
      var d = S.detail;
      if (d.busy) return;
      d.busy = true;
      seasonEps(it, season.id, function (err, eps) {
        if (S.detail !== d) return;
        d.busy = false;
        if (err) return toast(err);
        if (!eps.length) return toast('No episodes in ' + season.name);
        pushList(season.name, function () { return episodeActions(it, season, eps); }, firstUnseen(it, eps));
      });
    } };
  }

  function episodeActions(it, season, eps) {
    var acts = [], seen = seenOf(it.id), cur = recentFor(it.id);
    for (var j = 0; j < eps.length; j++) {
      (function (j) {
        var r = resumeOf(it.id + ':' + eps[j].id), done = !!seen[eps[j].id];
        var next = !r && cur && cur.ref && String(cur.ref.episode_id) === String(eps[j].id);
        acts.push({ id: 'e' + eps[j].id, label: eps[j].name, seen: done && !r && !next,
          right: r ? leftText(r) : next ? 'Up next' : done ? '✓ Watched' : '', prog: r && r.len ? r.pos / r.len : 0,
          fn: function () { playVod(epReq(it, season, eps, j, r ? r.pos : 0)); } });
      })(j);
    }
    return acts;
  }

  function pushList(crumb, build, idx) {
    var d = S.detail;
    d.stack.push({ list: d.list, idx: d.idx, crumb: d.crumb, rebuild: d.rebuild });
    d.list = build(); d.idx = idx || 0; d.crumb = crumb; d.rebuild = build;
    drawDetail();
  }

  function drawDetail() {
    var d = S.detail, h = '';
    for (var i = 0; i < d.list.length; i++) {
      var a = d.list[i];
      h += '<div class="act' + (i === d.idx ? ' focus' : '') + (a.right ? ' has-r' : '') + (a.seen ? ' seen' : '') +
        (a.dead ? ' dead' : '') + '" id="a' + i + '">' + esc(a.label) +
        (a.right ? '<span class="a-r">' + esc(a.right) + '</span>' : '') +
        (a.chev ? '<span class="chev">›</span>' : '') +
        (a.prog ? '<div class="pr"><i style="width:' + pct(a.prog) + '%"></i></div>' : '') + '</div>';
    }
    var box = $('d-list');
    box.innerHTML = h;
    $('d-crumb').innerHTML = esc(d.crumb);
    setFlag('dsub', d.stack.length > 0);
    box.style.height = Math.max(110, 600 - box.offsetTop) + 'px';       // the list takes what the text leaves
    box.scrollTop = 0;
    ensureVisible(box, $('a' + d.idx), 56);
  }
  function focusAct(i) {
    var d = S.detail;
    cls($('a' + d.idx), 'focus', false);
    d.idx = i;
    cls($('a' + i), 'focus', true);
    ensureVisible($('d-list'), $('a' + i), 56);
  }

  function closeDetail() {
    var d = S.detail;
    S.detail = null;
    S.flags.detail = S.flags.dsub = false;
    setZone(d.back);
    if (d.back === 'home') homeRefresh(); else refreshGrid();
  }
  function detailKey(k) {
    var d = S.detail, n = d.list.length, i = d.idx;
    if (k === K.UP) i = Math.max(0, i - 1);
    else if (k === K.DOWN) i = Math.min(n - 1, i + 1);
    else if (k === K.PGDN) i = Math.min(n - 1, i + 6);
    else if (k === K.PGUP) i = Math.max(0, i - 6);
    else if (k === K.OK || k === K.RIGHT) { if (d.list[i]) d.list[i].fn(); return; }
    else if (k === K.PLAY) { var a = d.stack.length ? d.list[i] : d.list[0]; if (a) a.fn(); return; }
    else if (k === K.BLUE) { toggleFav(d.item); if (!d.stack.length) buildMain(); return; }
    else if (k === K.BACK || k === K.LEFT) {
      if (d.stack.length) {
        var s = d.stack.pop();
        d.list = s.list; d.idx = s.idx; d.crumb = s.crumb; d.rebuild = s.rebuild;
        if (!d.stack.length) buildMain(); else drawDetail();
      } else closeDetail();
      return;
    } else return;
    if (i !== d.idx) focusAct(i);
  }
  function rebuildDetail() {
    var d = S.detail;
    if (!d) return;
    if (!d.stack.length) return buildMain();
    var idx = d.idx, r = recentFor(d.item.id);
    d.list = d.rebuild();
    d.idx = Math.min(idx, d.list.length - 1);
    for (var i = 0; r && r.ref && i < d.list.length; i++) {         // the cursor moves on to the episode now due
      if (d.list[i].id === 'e' + r.ref.episode_id) d.idx = i;
    }
    drawDetail();
  }

  // ---------------------------------------------------------------- player
  // Zones: starting (asking for the stream) -> player -> upnext (an episode ended) / back to where you were.
  var P = { o: null, prevZone: 'home', paused: false, seekTo: null, seekTimer: null, osdTimer: null, tick: null,
    started: false, reqTok: 0, up: null, upTimer: null };
  var video = $('video');

  P.init = function () {
    if (MAG) {
      try {
        gSTB.InitPlayer();
        gSTB.SetTopWin(0);
        gSTB.SetAspect(0x10);
        gSTB.SetPIG(1, -1, -1, -1);
        if (gSTB.EnableServiceButton) gSTB.EnableServiceButton(true);
        if (gSTB.EnableVKButton) gSTB.EnableVKButton(true);
      } catch (e) { /* older API */ }
      window.stbEvent = { event: 0, onEvent: function (code) { P.event(parseInt(code, 10)); } };
    } else {
      video.addEventListener('playing', function () { P.event(4); }, false);
      video.addEventListener('ended', function () { P.event(1); }, false);
      video.addEventListener('error', function () { P.event(5); }, false);
    }
  };
  P.pos = function () { try { return MAG ? gSTB.GetPosTime() : video.currentTime || 0; } catch (e) { return 0; } };
  P.len = function () {
    try { return MAG ? gSTB.GetMediaLen() : (isFinite(video.duration) ? video.duration : 0); } catch (e) { return 0; }
  };
  P.seek = function (sec) { if (MAG) gSTB.SetPosTime(Math.floor(sec)); else video.currentTime = sec; };

  function loaderText(title, sub) {
    $('ld-title').innerHTML = esc(title || '');
    $('ld-sub').innerHTML = esc(sub || '');
  }
  // Covers the screen from the key press until the first frame, so a slow portal never looks like a dead button.
  function beginLoading(title, sub) {
    if (S.zone !== 'player' && S.zone !== 'starting' && S.zone !== 'upnext' && S.zone !== 'pmenu') P.prevZone = S.zone;
    loaderText(title, sub);
    S.flags.loading = true; S.flags.osd = false;
    if (S.zone !== 'starting') setZone('starting'); else bodyClass();
    return ++P.reqTok;
  }
  function failStart(msg) {
    P.exit();
    toast('Could not play: ' + msg);
  }

  P.open = function (url, o) {
    if (window.fkTransport) fkTransport.subtitleOff();   // no subtitle carries over to the next title
    clearTimeout(P.subTimer);                            // a pending delay-apply must not fire for the new title
    if (P.o) P.stop();
    P.o = o; P.url = url; P.paused = false; P.started = false; P.seekTo = null; P.resumeTo = null; P.landTo = null;
    // Track selections (subtitles off by default). hlsSubs is null until the menu is first
    // opened: we don't ask the provider for the track list during normal playback.
    // TV: portal streams start their video 600 s into the timeline, while the
    // subtitles start at 0, so the TV starts 600 s early. The Delay row adjusts from there.
    P.subSel = -1; P.subShift = window.fkTransport ? -600 : 0; P.audPid = null; P.hlsSubs = null;
    S.flags.playing = true; S.flags.live = o.kind === 'live'; S.flags.loading = true; S.flags.osd = false;
    setZone('player');
    if (MAG) {
      // The MAG firmware keeps the last external/PID subtitle on across Play(), so switch it off here.
      try { gSTB.SetSubtitles(false); } catch (e) { /* n/a */ }
      gSTB.Play('ffmpeg ' + url);
    } else {
      video.src = url;
      var pr = video.play();
      if (pr && pr['catch']) pr['catch'](noop);          // a stop before the first frame is not an error
    }
    clearInterval(P.tick);
    P.tick = setInterval(function () {
      if (!P.started && P.pos() > 0) P.onStarted();
      if (P.started) P.applyResume();
      if (S.flags.osd) P.drawOsd();
      if (P.started && P.resumeTo == null && o.kind === 'vod' && Math.floor(Date.now() / 1000) % 10 === 0) {
        saveProgress(o, P.pos(), P.len());
      }
    }, 1000);
  };

  P.stop = function () {
    var o = P.o;
    if (o && o.kind === 'vod' && P.started && P.resumeTo == null && saveProgress(o, P.pos(), P.len())) {
      resolveNext(o, function (n) {                      // stopped in the credits: line the next episode up
        if (!n) return;
        pointRecent(n);
        if (S.zone === 'home') homeRefresh();
        else if (S.zone === 'detail') rebuildDetail();
      });
    }
    P.started = false;
    clearInterval(P.tick); clearTimeout(P.seekTimer); clearTimeout(P.osdTimer);
    if (MAG) { try { gSTB.Stop(); } catch (e) { /* ignore */ } }
    else { video.pause(); video.removeAttribute('src'); video.load(); }
    if (P.url && o && o.kind === 'vod') api('/api/vod/release', { url: P.url }, noop);
    P.url = null;
  };

  // Leave the player screens for wherever playback was started from.
  P.exit = function () {
    P.reqTok++;                                          // a stream still being asked for is no longer wanted
    P.o = null;
    clearInterval(P.upTimer); P.up = null;
    clearTimeout(zapTimer); P.zapTo = null;
    S.flags.playing = S.flags.osd = S.flags.live = S.flags.loading = S.flags.upnext = false;
    setZone(P.prevZone);
    if (S.zone === 'detail') rebuildDetail();
    else if (S.zone === 'grid') refreshGrid();
    else if (S.zone === 'home') homeRefresh();
  };
  P.close = function () { P.stop(); P.exit(); };

  P.event = function (code) {
    var o = P.o;
    if (!o) return;
    if (code === 4 && !P.started) {           // playback started
      P.onStarted();
    } else if (code === 1) {                  // end of stream
      if (o.kind !== 'vod') return P.close();
      saveProgress(o, P.len() || 1, P.len() || 1);
      P.started = false;                      // already saved: stop() must not save again
      P.stop();
      P.o = null;
      var tok = ++P.reqTok;
      resolveNext(o, function (n) {
        if (tok !== P.reqTok) return;         // left the player meanwhile
        if (!n) return P.exit();
        pointRecent(n);
        showUpNext(n);
      });
    } else if (code === 5) {                  // could not open
      if (o.kind === 'live' && !P.started) {  // live channel with no stream: skip to the next one
        var idx = o.idx;
        P.stop();
        return liveSkip(idx, 'playback failed');
      }
      // Say when it failed: before the stream started, or after (e.g. during a resume seek).
      var when = !P.started ? 'while opening' : (P.resumeTo != null ? 'while resuming at ' + fmt(P.resumeTo) : 'during playback');
      P.close();
      toast('Playback failed ' + when);
    }
  };

  P.onStarted = function () {
    P.started = true;
    setFlag('loading', false);
    // TV: start loading the subtitles now, so the Green menu opens quickly.
    if (window.fkTransport && P.o && P.o.kind === 'vod' && P.url) {
      fkTransport.api('/api/vod/subs', { url: P.url }, function () {});
    }
    P.resumeTo = P.o.start > 5 ? P.o.start : null;
    P.resumeTries = 0;
    if (P.resumeTo != null) P.land(P.resumeTo, 8000);    // show the resume point, not 0:00, while the seek lands
    P.osd(true);
  };

  // Seek to the resume point once the stream knows its length; re-try until the position lands.
  P.applyResume = function () {
    if (P.resumeTo == null || !(P.len() > 0)) return;
    if (Math.abs(P.pos() - P.resumeTo) < 20 || P.resumeTries >= 6) { P.resumeTo = null; return; }
    P.resumeTries++;
    P.seek(P.resumeTo);
  };
  // After a seek the player reports the old position for a moment. Show the target until it catches up.
  P.land = function (sec, ms) { P.landTo = sec; P.landUntil = Date.now() + ms; };

  P.osd = function (show, state) {
    setFlag('osd', show);
    P.state = state || '';
    clearTimeout(P.osdTimer);
    if (show) {
      P.drawOsd();
      if (!P.paused && !state) P.osdTimer = setTimeout(function () { setFlag('osd', false); }, 4000);
    }
  };

  function osdHint(o) {
    if (o.kind === 'live') return kb('▲ ▼', 'Channel') + kb(BACK, 'Exit');
    return kb('OK', 'Pause') + kb('◄ ►', '30 s') + kb('▲ ▼', '5 min') +
      kc('green', MAG ? 'Audio & subtitles' : 'Subtitles') + kb(BACK, 'Exit');
  }
  P.drawOsd = function () {
    var o = P.o; if (!o) return;
    var len = P.len(), cur = P.pos(), pos = cur, seeking = P.seekTo != null;
    if (seeking) pos = P.seekTo;
    else if (P.landTo != null) {
      if (Math.abs(cur - P.landTo) < 15 || Date.now() > P.landUntil) P.landTo = null; else pos = P.landTo;
    }
    var live = o.kind === 'live', ch = live && P.zapTo != null ? S.grid.items[P.zapTo] : null;
    $('osd-title').innerHTML = ch ? '<i>' + esc(ch.number) + '</i>' + esc(ch.name)
      : live ? '<i>' + esc(o.num) + '</i>' + esc(o.label) : esc(o.item.name);
    $('osd-sub').innerHTML = esc(live ? 'Live' : o.label !== o.item.name ? o.label : '');
    $('osd-clock').innerHTML = hhmm(new Date());
    var f = len ? Math.min(100, 100 * pos / len) : 0;
    $('osd-fill').style.width = f + '%';
    $('osd-knob').style.left = f + '%';
    $('osd-pos').innerHTML = fmt(pos);
    $('osd-end').innerHTML = len ? '-' + fmt(len - pos) + ' &nbsp;·&nbsp; ends ' + hhmm(new Date(Date.now() + (len - pos) * 1000)) : '';
    var ico = P.state ? 'none' : P.paused ? 'pause' : '', text = P.state || (P.paused ? 'Paused' : 'Playing');
    if (seeking && !P.state) {
      var d = P.seekTo - P.seekFrom;
      ico = 'none';
      text = (d < 0 ? '◄◄  −' : '►►  +') + fmt(Math.abs(d));
    }
    $('osd-ico').className = ico;
    $('osd-text').innerHTML = esc(text);
    $('osd-hint').innerHTML = osdHint(o);
  };

  // Each press moves by `step` seconds; holding the key speeds up (x2 after 6 presses, x4 after 12).
  P.nudge = function (dir, step) {
    if (!P.started) return;
    var len = P.len();
    if (P.seekTo == null) { P.seekFrom = P.landTo != null ? P.landTo : P.pos(); P.seekN = 0; P.seekDir = dir; }
    if (dir !== P.seekDir) { P.seekDir = dir; P.seekN = 0; }
    P.seekN++;
    var base = P.seekTo != null ? P.seekTo : P.seekFrom, d = dir * step * (P.seekN > 12 ? 4 : P.seekN > 6 ? 2 : 1);
    P.seekTo = Math.max(0, Math.min(len ? len - 5 : base + d, base + d));
    P.osd(true);
    clearTimeout(P.seekTimer);
    P.seekTimer = setTimeout(function () {
      var to = P.seekTo;
      P.seek(to);
      P.seekTo = null;
      P.land(to, 3000);
      P.osd(true);
    }, 800);
  };

  P.toggle = function () {
    if (!P.started) return;
    P.paused = !P.paused;
    if (MAG) { if (P.paused) gSTB.Pause(); else gSTB.Continue(); }
    else if (P.paused) video.pause(); else video.play();
    P.osd(true);
  };

  function playerKey(k) {
    if (!P.o) {                                // between episodes, working out what is next
      if (k === K.BACK || k === K.STOP) P.exit();
      return;
    }
    var live = P.o.kind === 'live';
    if (k === K.BACK || k === K.STOP) return P.close();
    if (k === K.GREEN) return P.openMenu();
    if (k === K.INFO) return P.osd(!S.flags.osd);
    if (live) {
      if (k === K.UP || k === K.PGUP) return zap(-1);
      if (k === K.DOWN || k === K.PGDN) return zap(1);
      if (k === K.OK) return P.osd(true);
      return;
    }
    if (k === K.OK || k === K.PLAY) P.toggle();
    else if (k === K.LEFT) P.nudge(-1, 30);
    else if (k === K.RIGHT) P.nudge(1, 30);
    else if (k === K.REW) P.nudge(-1, 120);
    else if (k === K.FFWD) P.nudge(1, 120);
    else if (k === K.DOWN) P.nudge(-1, 300);
    else if (k === K.UP) P.nudge(1, 300);
  }
  function startingKey(k) {                    // the stream has not been opened yet: Back simply calls it off
    if (k === K.BACK || k === K.STOP) P.exit();
  }

  // --- up next: an episode ended and there is another one ---
  var UP_SECS = 10;
  function showUpNext(n) {
    var it = n.item;
    P.up = { n: n, left: UP_SECS };
    $('u-poster').innerHTML = '<span class="ph">' + esc(it.name) + '</span>' +
      (it.poster ? '<img src="' + esc(it.poster) + '" onerror="this.style.display=\'none\'">' : '');
    $('u-title').innerHTML = esc(it.name);
    $('u-ep').innerHTML = esc(n.label);
    $('u-hint').innerHTML = kb('OK', 'Play now') + kb(BACK, 'Stop here');
    ambient($('u-amb'), it.poster);
    $('u-fill').style.width = '0';
    S.flags.upnext = true; S.flags.loading = false; S.flags.osd = false;
    setZone('upnext');
    drawUpNext();
    clearInterval(P.upTimer);
    P.upTimer = setInterval(function () {
      if (!P.up) return clearInterval(P.upTimer);
      if (--P.up.left <= 0) playUp(); else drawUpNext();
    }, 1000);
  }
  function drawUpNext() {
    var u = P.up;
    $('u-count').innerHTML = 'Starts in ' + u.left + ' s';
    $('u-fill').style.width = pct((UP_SECS - u.left + 1) / UP_SECS) + '%';
  }
  function playUp() {
    var n = P.up && P.up.n;
    clearInterval(P.upTimer);
    P.up = null;
    if (!n) return P.exit();
    playVod(n);
    setFlag('upnext', false);
  }
  function upnextKey(k) {
    if (k === K.OK || k === K.PLAY) playUp();
    else if (k === K.BACK || k === K.STOP) P.exit();
  }

  // --- audio & subtitle menu (during playback) ---
  function tracks(fn) {
    var r;
    try { r = gSTB[fn](); } catch (e) { return []; }
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return []; } }
    return r && r.length ? r : [];
  }
  // Streams name their tracks by language code; show the language.
  var LANG = { eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', pan: 'Punjabi', pa: 'Punjabi', urd: 'Urdu', ur: 'Urdu',
    tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu', mal: 'Malayalam', ml: 'Malayalam', kan: 'Kannada', kn: 'Kannada',
    ben: 'Bengali', bn: 'Bengali', mar: 'Marathi', mr: 'Marathi', guj: 'Gujarati', gu: 'Gujarati', fre: 'French', fra: 'French',
    fr: 'French', spa: 'Spanish', es: 'Spanish', ger: 'German', deu: 'German', de: 'German', ara: 'Arabic', ar: 'Arabic' };
  function langName(code) { return LANG[String(code || '').toLowerCase()] || code; }
  function trackLabel(t, i) {
    return esc(langName(t.lang) || t.name || t.title || ('Track ' + (i + 1)));
  }

  function delayText() {
    var v = P.subShift || 0;
    return (v > 0 ? '+' : '') + v.toFixed(2) + ' s';
  }
  function buildMenuItems() {
    var items = [];
    if (MAG) {                                 // the TV's player has one audio track
      items.push({ head: 'AUDIO' });
      var a = tracks('GetAudioPIDs');
      if (!a.length) items.push({ dead: 'Default' });
      for (var i = 0; i < a.length; i++) items.push({ kind: 'audio', pid: a[i].pid, label: trackLabel(a[i], i) });
    }
    items.push({ head: 'SUBTITLES' });
    items.push({ kind: 'sub', sub: -1, label: 'Off' });
    // Subtitles come from the stream's HLS tracks (merged to SRT by the server),
    // because this firmware doesn't expose them via GetSubtitlePIDs.
    var subs = P.hlsSubs || [];
    for (var j = 0; j < subs.length; j++) {
      items.push({ kind: 'sub', sub: j, label: esc(langName(subs[j].name || subs[j].lang) || ('Subtitles ' + (j + 1))) });
    }
    if (!subs.length) items.push({ dead: 'None in this title' });
    if (P.subSel >= 0) items.push({ kind: 'delay' });     // adjust sync once a track is on
    return items;
  }
  P.openMenu = function () {
    if ((!MAG && !window.fkTransport) || !P.o || !P.started) return;
    if (P.hlsSubs === null) {
      if (P.o.kind !== 'vod') P.hlsSubs = [];
      else {                                   // first open: look up this stream's subtitle tracks
        var url = P.url;
        toast('Loading tracks…', true);
        return api('/api/vod/subs', { url: url }, function (err, res) {
          hideToast();
          if (P.url !== url) return;           // stopped or switched while loading
          P.hlsSubs = (!err && res && res.length) ? res : [];
          if (S.zone === 'player') P.openMenu();
        });
      }
    }
    if (MAG && P.audPid == null) { try { P.audPid = parseInt(gSTB.GetAudioPID(), 10); } catch (e) { P.audPid = null; } }
    P.menu = { items: buildMenuItems() };
    P.menu.idx = menuStep(-1, 1);
    setFlag('osd', false);
    setZone('pmenu');
    drawMenu();
  };
  function rebuildMenu() {
    if (S.zone !== 'pmenu') return;
    var idx = P.menu.idx;
    P.menu.items = buildMenuItems();
    if (idx >= P.menu.items.length) idx = P.menu.items.length - 1;
    var it = P.menu.items[idx];
    if (it && (it.head || it.dead)) idx = menuStep(idx, 1);
    P.menu.idx = idx;
    drawMenu();
  }

  function menuStep(from, dir) {
    var it = P.menu.items, i = from + dir;
    while (i >= 0 && i < it.length && (it[i].head || it[i].dead)) i += dir;
    return (i >= 0 && i < it.length) ? i : from;
  }
  function menuCurrent(it) {
    return it.kind === 'audio' ? (it.pid == P.audPid) : (it.sub === P.subSel);
  }
  function drawMenu() {
    var it = P.menu.items, h = '', cur = it[P.menu.idx];
    for (var i = 0; i < it.length; i++) {
      if (it[i].head) h += '<div class="pm-head">' + esc(it[i].head) + '</div>';
      else if (it[i].dead) h += '<div class="pm-dead">' + esc(it[i].dead) + '</div>';
      else if (it[i].kind === 'delay') {
        h += '<div class="pm-item' + (i === P.menu.idx ? ' focus' : '') + '" id="m' + i + '">Delay<span class="pm-r">◄ &nbsp;' +
          delayText() + '&nbsp; ►</span></div>';
      } else {
        h += '<div class="pm-item' + (i === P.menu.idx ? ' focus' : '') + '" id="m' + i + '"><span class="chk">' +
          (menuCurrent(it[i]) ? '✓' : '') + '</span>' + it[i].label + '</div>';
      }
    }
    if (cur && cur.kind === 'delay') h += '<div class="pm-note">◄ ► 0.25 s &nbsp;·&nbsp; CH 30 s</div>';
    $('pmenu').innerHTML = h;
    ensureVisible($('pmenu'), $('m' + P.menu.idx), 44);
  }
  var subSeq = 0;
  function subUrl(sel) {
    // The trailing counter makes every load a distinct URL, so the player
    // reloads the subtitle after it was turned off (it ignores a repeat URL).
    return location.protocol + '//' + location.host + '/api/vod/subtitle?url=' +
      encodeURIComponent(P.url) + '&track=' + encodeURIComponent(P.hlsSubs[sel].name) +
      '&shift=' + (P.subShift || 0) + '&_=' + (++subSeq);
  }
  var subSeqTv = 0;
  function applySubTv(sel, announce) {         // TV: merged WebVTT attached as a <track>
    var track = P.hlsSubs[sel].name, shift = P.subShift || 0, url = P.url;
    if (window.console) console.log('[subtitles] track "' + track + '" with delay ' + shift + ' s');
    if (announce) toast('Loading subtitles…', true);
    var seq = ++subSeqTv;                       // only the newest request may apply
    fkTransport.subtitle(url, track, shift, function (err, vtt) {
      if (announce) hideToast();
      if (seq !== subSeqTv || P.url !== url) return;   // older delay, or stopped/switched
      if (err || !vtt || !fkTransport.setSubtitles(vtt)) { toast('Could not load subtitles'); return; }
      P.subSel = sel;
      if (announce) { toast((langName(P.hlsSubs[sel].name) || 'Subtitles') + ' on'); rebuildMenu(); }
    });
  }
  function applySub(sel, announce) {
    if (window.fkTransport) return applySubTv(sel, announce);         // warm the server merge, then hand the SRT to the player
    var url = subUrl(sel), streamUrl = P.url;
    if (announce) toast('Loading subtitles…', true);
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (announce) hideToast();
      if (P.url !== streamUrl) return;     // title changed while loading: don't attach it to the new one
      if (x.status !== 200) { toast('Could not load subtitles'); return; }
      try {
        gSTB.LoadExternalSubtitles(url);
        gSTB.SetSubtitles(true);
        P.subSel = sel;
        if (announce) { toast((langName(P.hlsSubs[sel].name) || 'Subtitles') + ' on'); rebuildMenu(); }
      } catch (e) { toast('Subtitles not supported'); }
    };
    x.send();
  }
  function adjustDelay(d) {
    if (P.subSel < 0) return;
    P.subShift = Math.round((P.subShift + d) * 100) / 100;
    if (window.console) console.log('[subtitles] delay set to ' + P.subShift + ' s');
    drawMenu();
    clearTimeout(P.subTimer);
    P.subTimer = setTimeout(function () { applySub(P.subSel, false); }, 400);
  }
  function menuApply(it) {
    if (!it) return;
    if (it.kind === 'audio') {
      try { gSTB.SetAudioPID(it.pid); P.audPid = it.pid; } catch (e) { /* n/a */ }
      drawMenu();
    } else if (it.kind === 'sub') {
      if (it.sub === -1) {
        try { gSTB.SetSubtitles(false); } catch (e) { /* n/a */ }
        if (window.fkTransport) fkTransport.subtitleOff();
        clearTimeout(P.subTimer);                // cancel a pending delay-apply for the track just turned off
        P.subSel = -1;
        rebuildMenu();
      }
      else applySub(it.sub, true);
    }
  }
  P.closeMenu = function () { setZone('player'); P.osd(true); };
  function pmenuKey(k) {
    var m = P.menu, it = m.items[m.idx];
    if (k === K.BACK || k === K.GREEN || k === K.INFO) return P.closeMenu();
    if (it && it.kind === 'delay' && (k === K.PGUP || k === K.PGDN)) {
      return adjustDelay(k === K.PGDN ? 30 : -30);         // CH+/CH-: 30 s steps
    }
    if (it && it.kind === 'delay' && (k === K.LEFT || k === K.RIGHT)) {
      return adjustDelay(k === K.LEFT ? -0.25 : 0.25);     // ◀ ▶ nudge subtitle timing
    }
    if (k === K.UP) m.idx = menuStep(m.idx, -1);
    else if (k === K.DOWN) m.idx = menuStep(m.idx, 1);
    else if (k === K.OK || k === K.RIGHT) { menuApply(it); return; }
    else return;
    drawMenu();
  }

  // --- starting playback ---
  function playVod(o) {
    o.kind = 'vod';
    var tok = beginLoading(o.item.name, o.start > 5 ? 'Resuming at ' + fmt(o.start) : o.label !== o.item.name ? o.label : '');
    api('/api/vod/play', o.ref, function (err, res) {
      if (tok !== P.reqTok) {                  // called off while the portal was thinking: give the stream slot back
        if (!err && res && res.url) api('/api/vod/release', { url: res.url }, noop);
        return;
      }
      if (err || !res.url) return failStart(err || 'No stream available');
      P.open(res.url, o);
    });
  }
  // PLAY on a tile, or OK in Continue watching: straight into the title, where you left it.
  function quickPlay(it) {
    if (!it) return;
    var r = recentFor(it.id);
    if (r && r.ref) return playVod(recentReq(r, it));
    if (it.is_series) return startSeries(it);
    var res = resumeOf(it.id);
    playVod(movieReq(it, res && res.pos >= MIN_RESUME ? res.pos : 0));
  }
  function startSeries(it) {                   // a series with no history: its first episode not yet watched
    var tok = beginLoading(it.name, '');
    seasonsOf(it, function (err, seasons) {
      if (tok !== P.reqTok) return;
      if (err || !seasons.length) return failStart(err || 'No episodes found');
      seasonEps(it, seasons[0].id, function (err2, eps) {
        if (tok !== P.reqTok) return;
        if (err2 || !eps.length) return failStart(err2 || 'No episodes found');
        playVod(epReq(it, seasons[0], eps, firstUnseen(it, eps), 0));
      });
    });
  }

  function playLive(i, zapping) {
    var ch = S.grid.items[i];
    if (!ch) return;
    if (S.zone === 'grid') focusTile(i);
    var tok = zapping ? ++P.reqTok : beginLoading(ch.name, 'Channel ' + ch.number);
    if (zapping) loaderText(ch.name, 'Channel ' + ch.number);
    api('/api/live/link', { cmd: ch.cmd }, function (err, res) {
      if (tok !== P.reqTok) return;            // another channel was chosen meanwhile
      if (err || !res.url) return liveSkip(i, err || 'Channel unavailable');
      skipRun = 0;
      P.zapTo = null;
      P.open(res.url, { kind: 'live', label: ch.name, num: ch.number, idx: i });
    });
  }

  // A channel with no working stream: say so and move on to the next channel.
  // Gives up after MAX_SKIP channels in a row, so a whole group with no streams
  // doesn't loop forever.
  var skipRun = 0, MAX_SKIP = 5;
  function liveSkip(i, why) {
    var n = S.grid.items.length;
    if (skipRun >= MAX_SKIP || i + 1 >= n) {
      skipRun = 0;
      P.zapTo = null;
      P.close();
      toast('No working channel found: ' + why);
      return;
    }
    skipRun++;
    toast('No stream on this channel, trying the next one…');
    if (P.o) P.o.idx = i + 1;
    if (P.zapTo != null) P.zapTo = i + 1;
    playLive(i + 1, !!P.o);
  }

  // CH+/CH- while watching: the name shows at once, the stream follows when the presses stop.
  var zapTimer;
  function zap(delta) {
    var from = P.zapTo != null ? P.zapTo : P.o.idx, i = from + delta, n = S.grid.items.length;
    if (i < 0 || i >= n) return;
    P.zapTo = i;
    P.reqTok++;                                // a channel still being fetched is no longer the one wanted
    P.osd(true, 'Switching…');
    clearTimeout(zapTimer);
    zapTimer = setTimeout(function () {
      if (!P.o) return;
      P.o.idx = i;
      playLive(i, true);
    }, 350);
  }

  // ------------------------------------------------------------------ keys
  var handlers = { tabs: tabsKey, home: homeKey, cats: catsKey, search: searchKey, find: findKey, grid: gridKey,
    detail: detailKey, starting: startingKey, player: playerKey, upnext: upnextKey, pmenu: pmenuKey, pin: pinKey };
  // Map raw key events to K.* (MAG sends media keys as Alt+letter, CH+/- as Tab).
  function normKey(e) {
    var c = e.keyCode;
    if (window.fkKeyMap && fkKeyMap.hasOwnProperty(c)) return fkKeyMap[c];     // TV remote (tv/app/transport.js)
    if (c === 9) return e.shiftKey ? K.PGDN : K.PGUP;
    if (e.altKey) return c === 80 ? K.INFO : c;               // Alt+R/S/B/F/P
    if (c === 8) return (S.zone === 'search' || S.zone === 'find' || S.zone === 'pin') ? 8 : K.BACK;  // Backspace edits the search text
    if (MAG && (c === 82 || c === 83 || c === 66 || c === 70 || c === 89)) return 0; // plain letters
    return c;
  }
  // Search-as-you-type: debounce so we don't hit the API on every keystroke.
  var liveTimer;
  function scheduleLive() { clearTimeout(liveTimer); liveTimer = setTimeout(liveSearch, 300); }
  function liveSearch() {
    if (S.zone === 'find') {
      var q = trim($('find').value);
      if (q.length >= 2) runFind(q, true);
      else if (!q && S.flags.scoped) clearFind();
    } else if (S.zone === 'search') {
      var s = trim($('search').value);
      if (s.length >= 2) runSearch(s);
      else searchIdle();
    }
  }

  // Keys the UI consumes (normalised). Anything else — volume, mute, power —
  // is left for the MAG firmware to handle, so we must NOT preventDefault it.
  var USED = {};
  [K.LEFT, K.UP, K.RIGHT, K.DOWN, K.OK, K.BACK, K.PGUP, K.PGDN,
   K.PLAY, K.STOP, K.REW, K.FFWD, K.INFO, K.RED, K.BLUE, K.GREEN, K.YELLOW].forEach(function (c) { USED[c] = 1; });

  // Volume: this firmware delivers the keys to us (107/109, mute 192+Alt) but
  // doesn't act on them, so we drive the player's volume directly.
  var volTimer;
  function showVol(v, muted) {
    $('volfill').style.height = (muted ? 0 : v) + '%';
    $('voltxt').innerHTML = muted ? 'mute' : v;
    $('volosd').className = 'on';
    clearTimeout(volTimer);
    volTimer = setTimeout(function () { $('volosd').className = ''; }, 1500);
  }
  function setVol(d) {
    if (!MAG) return;
    try {
      var v = Math.max(0, Math.min(100, (parseInt(gSTB.GetVolume(), 10) || 0) + d));
      gSTB.SetMute(false);
      gSTB.SetVolume(v);
      showVol(v, false);
    } catch (e) { /* n/a */ }
  }
  function toggleMute() {
    if (!MAG) return;
    try { var m = !gSTB.GetMute(); gSTB.SetMute(m); showVol(parseInt(gSTB.GetVolume(), 10) || 0, m); } catch (e) { /* n/a */ }
  }

  // Key-code readout (MAG/desktop only): shows each key's code in a yellow box for
  // 4 seconds, for finding remote and keyboard codes. Remove this block when done.
  /*
  var keyDbg = null, keyDbgTimer;
  document.addEventListener('keydown', function (e) {
    if (window.fkTransport) return;                    // the TV build has its own readout
    if (!keyDbg) {
      keyDbg = document.createElement('div');
      keyDbg.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:9999;font:28px monospace;' +
        'background:rgba(0,0,0,.8);color:#ff0;padding:8px 14px;border-radius:6px;display:none';
      document.body.appendChild(keyDbg);
    }
    keyDbg.textContent = 'key ' + e.keyCode + (e.key ? '  ' + e.key : '');
    keyDbg.style.display = 'block';
    clearTimeout(keyDbgTimer);
    keyDbgTimer = setTimeout(function () { keyDbg.style.display = 'none'; }, 4000);
  }, false);
  */
  document.addEventListener('keydown', function (e) {
    if ((e.keyCode === 112 || e.keyCode === 403) && S.zone !== 'search') {   // Red button (403 on webOS): reload the portal
      if (P.o) P.stop();
      location.reload();
      return;
    }
    if (e.keyCode === 107 || e.keyCode === 187 || e.keyCode === 61) { setVol(5); e.preventDefault(); return; }
    if (e.keyCode === 109 || e.keyCode === 189 || e.keyCode === 173) { setVol(-5); e.preventDefault(); return; }
    if (e.keyCode === 192 && e.altKey) { toggleMute(); e.preventDefault(); return; }  // Mute
    var nk = normKey(e);
    var h = handlers[S.zone];
    if (h && h(nk, e) === false) { scheduleLive(); return; }  // typing fell through
    if (USED[nk]) e.preventDefault();                 // only swallow our own keys
  }, false);
  // The MAG on-screen keyboard may insert text without a keydown; cover that too.
  $('search').addEventListener('input', scheduleLive, false);
  $('find').addEventListener('input', scheduleLive, false);

  // ------------------------------------------------------------------ boot
  function scale() {
    var z = (window.innerWidth || 1280) / 1280;
    document.body.style.zoom = z;
  }
  function clock() {
    $('clock').innerHTML = hhmm(new Date());
  }

  scale();
  window.addEventListener('resize', scale, false);
  clock(); setInterval(clock, 15000);
  // Mouse / Magic Remote pointer: clicks only, no hover, so the pointer never
  // moves the highlight away from the remote's focus. Each click runs the same
  // action as pressing OK on that item. The wheel scrolls like the arrow keys.
  function indexOfId(el, prefix) {
    for (var n = el; n && n !== document.body; n = n.parentNode) {
      if (n.id && n.id.indexOf(prefix) === 0 && /^\d+$/.test(n.id.slice(prefix.length))) return +n.id.slice(prefix.length);
    }
    return -1;
  }
  function bindMouse() {
    $('grid').addEventListener('click', function (e) {
      var i = indexOfId(e.target, 't'); if (i < 0) return;
      if (S.zone !== 'grid') setZone('grid');
      focusTile(i);
      gridKey(K.OK);
    }, false);
    $('rows').addEventListener('click', function (e) {
      for (var n = e.target; n && n !== document.body; n = n.parentNode) {
        var m = n.id && /^h(\d+)_(\d+)$/.exec(n.id);
        if (!m) continue;
        if (S.zone !== 'home') setZone('home');
        S.home.touched = true;
        homeFocus(+m[1], +m[2]);
        return homeKey(K.OK);
      }
    }, false);
    $('cats').addEventListener('click', function (e) {
      var i = indexOfId(e.target, 'c'); if (i < 0 || !catSelectable(i)) return;
      if (S.zone !== 'cats') setZone('cats');
      focusCat(i);
      catsKey(K.OK);
    }, false);
    $('d-list').addEventListener('click', function (e) {
      var i = indexOfId(e.target, 'a'); if (i < 0 || !S.detail) return;
      focusAct(i);
      detailKey(K.OK);
    }, false);
    $('pmenu').addEventListener('click', function (e) {
      var i = indexOfId(e.target, 'm'); if (i < 0 || S.zone !== 'pmenu') return;
      P.menu.idx = i; drawMenu();
      pmenuKey(K.OK);
    }, false);
    $('tabs').addEventListener('click', function (e) {
      for (var i = 0, n = $('tabs').children; i < n.length; i++) {
        if (n[i] === e.target || (n[i].contains && n[i].contains(e.target))) {
          if (S.zone !== 'tabs') setZone('tabs');
          selectTab(i);
          return;
        }
      }
    }, false);
    $('search').addEventListener('click', function () { if (S.zone !== 'search') setZone('search'); }, false);
    $('find').addEventListener('click', function () { if (S.zone !== 'find') setZone('find'); }, false);
    $('upnext').addEventListener('click', function () { if (S.zone === 'upnext') playUp(); }, false);
    var wheelAt = 0;
    document.addEventListener('wheel', function (e) {
      var now = Date.now(), z = S.zone;
      if (now - wheelAt < 140 || !e.deltaY) return;   // one step per notch
      if (z !== 'grid' && z !== 'home' && z !== 'cats' && z !== 'detail' && z !== 'pmenu') return;
      wheelAt = now;
      handlers[z](e.deltaY > 0 ? K.DOWN : K.UP);
    }, false);
  }

  P.init();
  bindMouse();
  bodyClass();
  selectTab(0);
  setZone('home');
})();
