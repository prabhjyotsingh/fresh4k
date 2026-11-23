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
    RED: 112                      // Ctrl+F1 on MAG: reloads the portal
  };

  var TABS = [
    { id: 'vod', title: 'Movies & Series' },
    { id: 'live', title: 'Live TV' },
    { id: 'search', title: 'Search' },
    { id: 'mine', title: 'My List' }
  ];

  var MAG = !!window.gSTB;
  var S = {
    zone: 'cats', tab: 0, tabFocus: 0, cats: [], cat: 0, catFocus: 0, catTok: 0,
    grid: { items: [], idx: 0, cols: 5, kind: 'vod', src: null, page: 0, total: 0, done: true, loading: false, tok: 0 },
    detail: null, flags: {}
  };

  // ---------------------------------------------------------------- utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function qs(params) {
    var out = [];
    for (var k in params) if (params.hasOwnProperty(k)) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return out.join('&');
  }
  function api(path, params, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', path + '?' + qs(params || {}), true);
    x.timeout = 30000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
      if (x.status !== 200 || !data) return cb((data && data.error) || ('Server error ' + x.status));
      cb(null, data);
    };
    x.send();
  }
  // Favorites / resume points are stored on the server (state.json) so they survive box reboots.
  var STATE = (function () {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/state', false);
      x.send();
      return JSON.parse(x.responseText) || {};
    } catch (e) { return {}; }
  })();
  function load(key, dflt) {
    return STATE.hasOwnProperty(key) ? JSON.parse(JSON.stringify(STATE[key])) : dflt;
  }
  function save(key, v) {
    STATE[key] = v;
    var body = {}; body[key] = v;
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
    t.innerHTML = esc(msg);
    t.className = 'on';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, 2500);
  }
  function hideToast() { $('toast').className = ''; }

  function setFlag(name, on) { S.flags[name] = on; bodyClass(); }
  function bodyClass() {
    var c = ['tab-' + TABS[S.tab].id, 'z-' + S.zone];
    for (var f in S.flags) if (S.flags[f]) c.push(f);
    if (!MAG) c.push('desktop');
    document.body.className = c.join(' ');
  }
  function setZone(z) {
    S.zone = z;
    bodyClass();
    var input = z === 'search' ? $('search') : z === 'find' ? $('find') : null;
    if (input) {
      input.focus();
      try { if (MAG && gSTB.ShowVirtualKeyboard) gSTB.ShowVirtualKeyboard(); } catch (e) { /* n/a */ }
    } else {
      var a = document.activeElement;
      if (a && (a.id === 'search' || a.id === 'find')) {
        a.blur();
        try { if (MAG && gSTB.HideVirtualKeyboard) gSTB.HideVirtualKeyboard(); } catch (e) { /* n/a */ }
      }
    }
  }

  // ------------------------------------------------------- favorites/progress
  // favs: [vodItem]; resume: {key: {pos, len}}; recent: [{item, key, label, cmd, series, pos, len}]
  function favs() { return load('favs', []); }
  function isFav(it) { var f = favs(); for (var i = 0; i < f.length; i++) if (f[i].id === it.id) return true; return false; }
  function toggleFav(it) {
    var f = favs(), had = false;
    for (var i = 0; i < f.length; i++) if (f[i].id === it.id) { f.splice(i, 1); had = true; break; }
    if (!had) f.unshift(it);
    save('favs', f);
    toast(had ? 'Removed from My List' : 'Added to My List');
    return !had;
  }
  function resumeOf(key) { return load('resume', {})[key]; }
  function recentFor(id) {
    var r = load('recent', []);
    for (var i = 0; i < r.length; i++) if (r[i].item.id === id) return r[i];
    return null;
  }
  function saveProgress(o, pos, len) {
    if (!o || !o.key || !(pos > 0)) return;
    var resume = load('resume', {}), recent = load('recent', []), done = len > 0 && pos / len > 0.95;
    for (var i = 0; i < recent.length; i++) if (recent[i].item.id === o.item.id) { recent.splice(i, 1); break; }
    if (done) delete resume[o.key];
    else resume[o.key] = { pos: pos, len: len };
    if (!done) {
      recent.unshift({ item: o.item, key: o.key, label: o.label, ref: o.ref, pos: pos, len: len });
    }
    recent = recent.slice(0, 20);                 // keep the 20 most recent
    var keep = {};                                // drop resume points no longer in that list
    for (var j = 0; j < recent.length; j++) keep[recent[j].key] = 1;
    for (var k in resume) if (!keep[k]) delete resume[k];
    save('resume', resume);
    save('recent', recent);
  }

  // ---------------------------------------------------------------- tabs
  function drawTabs() {
    var h = '';
    for (var i = 0; i < TABS.length; i++) {
      h += '<span class="tab' + (i === S.tab ? ' sel' : '') + (i === S.tabFocus ? ' focus' : '') + '">' +
        esc(TABS[i].title) + '</span>';
    }
    $('tabs').innerHTML = h;
  }

  function selectTab(i) {
    S.tab = S.tabFocus = i;
    drawTabs();
    setFlag('cansearch', false);
    setFlag('scoped', false);
    var id = TABS[i].id;
    S.catTok++;
    if (id === 'vod') loadCats('/api/vod/categories');
    else if (id === 'live') loadCats('/api/live/genres');
    else if (id === 'mine') setCats([{ id: 'recent', title: 'Continue watching' }, { id: 'favs', title: 'Favorites' }]);
    else if (id === 'search') {
      setCats([]);
      var q = $('search').value;
      if (q) runSearch(q); else setGrid(null, 'Type to search all movies & series');
    }
  }

  function tabsKey(k) {
    if (k === K.LEFT && S.tabFocus > 0) { selectTab(S.tabFocus - 1); }
    else if (k === K.RIGHT && S.tabFocus < TABS.length - 1) { selectTab(S.tabFocus + 1); }
    else if (k === K.DOWN || k === K.OK) {
      if (TABS[S.tab].id === 'search') setZone('search');
      else if (S.cats.length) setZone('cats');
      else if (S.grid.items.length) setZone('grid');
    }
  }

  // ---------------------------------------------------------- categories
  function loadCats(path) {
    var tok = S.catTok;
    setCats([]);
    setGrid(null, 'Loading…');
    api(path, {}, function (err, data) {
      if (tok !== S.catTok) return;
      if (err) { setGrid(null, 'Could not load: ' + err); return; }
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

  function setCats(cats) {
    S.cats = cats;
    $('cats').scrollTop = 0;
    var first = catSnap(0);
    S.cat = S.catFocus = first < 0 ? 0 : first;
    drawCats();
    if (first >= 0) selectCat(first);
  }

  function drawCats() {
    var h = '';
    for (var i = 0; i < S.cats.length; i++) {
      if (S.cats[i].header) {
        h += '<div class="cat-head">' + esc(S.cats[i].header) + '</div>';
      } else {
        h += '<div class="cat' + (i === S.cat ? ' sel' : '') + (i === S.catFocus ? ' focus' : '') +
          '" id="c' + i + '">' + esc(S.cats[i].title) + '</div>';
      }
    }
    $('cats').innerHTML = h;
    ensureVisible($('cats'), $('c' + S.catFocus), 42);
  }

  function selectCat(i) {
    S.cat = i;
    drawCats();
    var tab = TABS[S.tab].id, id = S.cats[i].id;
    setFlag('cansearch', tab === 'vod');
    setFlag('scoped', false);
    if (tab === 'vod') {
      S.curCat = S.cats[i];
      $('find').value = '';
      $('find').placeholder = 'Search in ' + S.curCat.title;
      setGrid(remote('/api/vod/list', { category: id }), null, 5, 'vod');
    }
    else if (tab === 'live') setGrid(remote('/api/live/channels', { genre: id }), null, 4, 'live');
    else if (tab === 'mine') {
      var list = id === 'favs' ? favs() : (function () {
        var r = load('recent', []), out = [];
        for (var j = 0; j < r.length; j++) out.push(r[j].item);
        return out;
      })();
      setGrid(local(list), id === 'favs' ? 'Press ■ BLUE on any title to add it here' : 'Nothing watched yet', 5, 'vod');
    }
  }

  var catTimer;
  function catsKey(k) {
    var n = S.cats.length;
    if (k === K.UP) {
      var p = catStep(S.catFocus, -1);
      if (p < 0) return setZone('tabs');
      S.catFocus = p;
    } else if (k === K.DOWN) {
      var nx = catStep(S.catFocus, 1);
      if (nx >= 0) S.catFocus = nx;
    } else if (k === K.PGDN) { var sd = catSnap(Math.min(n - 1, S.catFocus + 10)); if (sd >= 0) S.catFocus = sd; }
    else if (k === K.PGUP) { var su = catSnap(Math.max(0, S.catFocus - 10)); if (su >= 0) S.catFocus = su; }
    else if (k === K.RIGHT || k === K.OK) {
      clearTimeout(catTimer);
      if (S.cat !== S.catFocus) selectCat(S.catFocus);
      return setZone('grid');
    } else if (k === K.BACK) return setZone('tabs');
    else return;
    drawCats();
    clearTimeout(catTimer);
    catTimer = setTimeout(function () { if (S.cat !== S.catFocus) selectCat(S.catFocus); }, 450);
  }

  // ------------------------------------------------- in-category search (find)
  function runFind(q, stay) {
    setFlag('scoped', true);
    setGrid(remote('/api/vod/list', { category: S.curCat.id, search: q }),
      'No results for "' + q + '" in ' + S.curCat.title, 5, 'vod');
    if (!stay) setZone('grid');                  // typing live keeps focus in the box
  }
  function clearFind() {                          // drop the scoped search, show the whole category
    setFlag('scoped', false);
    $('find').value = '';
    setGrid(remote('/api/vod/list', { category: S.curCat.id }), null, 5, 'vod');
  }
  function findKey(k) {
    var input = $('find');
    if (k === K.OK) {
      var q = input.value.replace(/^\s+|\s+$/g, '');
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
  function runSearch(q) {
    setGrid(remote('/api/vod/list', { search: q }), 'No results for "' + q + '"', 5, 'vod');
  }

  function searchKey(k) {
    var input = $('search');
    if (k === K.OK) {
      var q = input.value.replace(/^\s+|\s+$/g, '');
      if (q) { runSearch(q); setZone('grid'); }
    } else if (k === K.DOWN || k === K.RIGHT && input.selectionStart >= input.value.length) {
      if (S.grid.items.length) setZone('grid');
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
    return function (page, cb) { cb(null, { items: items, total: items.length }); };
  }

  function setGrid(src, emptyMsg, cols, kind) {
    var g = S.grid;
    g.tok++;
    g.items = []; g.idx = 0; g.page = 0; g.total = 0; g.loading = false;
    g.src = src; g.done = !src; g.empty = emptyMsg || 'Nothing here';
    if (cols) g.cols = cols;
    if (kind) g.kind = kind;
    $('grid').innerHTML = src ? '' : '<div class="empty">' + esc(emptyMsg || '') + '</div>';
    $('grid').scrollTop = 0;
    if (src) loadMore();
  }

  function loadMore() {
    var g = S.grid;
    if (g.loading || g.done) return;
    g.loading = true;
    var tok = g.tok;
    g.src(g.page + 1, function (err, res) {
      if (tok !== g.tok) return;
      g.loading = false;
      if (err) { g.done = true; if (!g.items.length) $('grid').innerHTML = '<div class="empty">' + esc(err) + '</div>'; return; }
      var start = g.items.length;
      g.page++;
      g.items = g.items.concat(res.items || []);
      g.total = res.total || 0;
      if (!res.items || !res.items.length || g.items.length >= g.total) g.done = true;
      if (!g.items.length) { $('grid').innerHTML = '<div class="empty">' + esc(g.empty) + '</div>'; return; }
      appendTiles(start);
    });
  }

  function tileHtml(it, i, kind) {
    var name = esc(it.name);
    if (kind === 'live') {
      return '<div class="tile ch" id="t' + i + '"><div class="poster"><span class="num">' + esc(it.number) + '</span>' +
        '<span class="ph">' + name + '</span>' +
        (it.logo ? '<img src="' + esc(it.logo) + '" onerror="this.style.display=\'none\'">' : '') +
        '</div><div class="name">' + name + '</div></div>';
    }
    var r = it.is_series ? null : resumeOf(it.id), prog = '';
    if (r && r.len) prog = '<div class="prog" style="width:' + Math.round(100 * r.pos / r.len) + '%"></div>';
    return '<div class="tile" id="t' + i + '"><div class="poster"><span class="ph">' + name + '</span>' +
      (it.poster ? '<img src="' + esc(it.poster) + '" onerror="this.style.display=\'none\'">' : '') +
      (it.rating ? '<span class="badge">★ ' + esc(it.rating) + '</span>' : '') +
      (it.is_series ? '<span class="badge s">SERIES</span>' : '') + prog +
      '</div><div class="name">' + name + (it.year ? ' (' + esc(it.year) + ')' : '') + '</div></div>';
  }

  function appendTiles(start) {
    var g = S.grid, h = '';
    for (var i = start; i < g.items.length; i++) h += tileHtml(g.items[i], i, g.kind);
    var div = document.createElement('div');
    div.innerHTML = h;
    var box = $('grid');
    while (div.firstChild) box.appendChild(div.firstChild);
    var el = $('t' + g.idx);
    if (el && el.className.indexOf(' focus') < 0) el.className += ' focus';
  }

  function focusTile(i) {
    var g = S.grid, old = $('t' + g.idx);
    if (old) old.className = old.className.replace(/ focus/g, '');
    g.idx = i;
    var el = $('t' + i);
    if (el) { el.className += ' focus'; ensureVisible($('grid'), el, 0); }
    if (g.items.length - i <= g.cols * 2) loadMore();
  }

  function gridKey(k) {
    var g = S.grid, n = g.items.length, i = g.idx, c = g.cols;
    if (!n) {
      if (k === K.BACK && S.flags.scoped) return clearFind();
      if (k === K.LEFT || k === K.BACK) leftOfGrid();
      else if (k === K.UP) setZone(S.flags.cansearch ? 'find' : 'tabs');
      return;
    }
    if (k === K.LEFT) { if (i % c === 0) return leftOfGrid(); i--; }
    else if (k === K.RIGHT) { if (i % c !== c - 1 && i + 1 < n) i++; }
    else if (k === K.UP) { if (i - c >= 0) i -= c; else return setZone(S.flags.cansearch ? 'find' : 'tabs'); }
    else if (k === K.DOWN) { if (i + c < n) i += c; else if (Math.floor(i / c) < Math.floor((n - 1) / c)) i = n - 1; }
    else if (k === K.PGDN) i = Math.min(n - 1, i + c * 2);
    else if (k === K.PGUP) i = Math.max(0, i - c * 2);
    else if (k === K.OK) return g.kind === 'live' ? playLive(i) : openDetail(g.items[i]);
    else if (k === K.BLUE && g.kind === 'vod') return toggleFav(g.items[i]);
    else if (k === K.BACK) return S.flags.scoped ? clearFind() : leftOfGrid();
    else return;
    focusTile(i);
  }

  function leftOfGrid() {
    if (TABS[S.tab].id === 'search') setZone('search');
    else if (S.cats.length) setZone('cats');
    else setZone('tabs');
  }

  // ---------------------------------------------------------------- detail
  function openDetail(it) {
    var d = S.detail = { item: it, stack: [], list: [], idx: 0, crumb: '', extra: null, rebuild: null };
    $('d-poster').innerHTML = it.poster ? '<img src="' + esc(it.poster) + '" onerror="this.style.display=\'none\'">' : '';
    $('d-title').innerHTML = esc(it.name);
    var meta = [];
    if (it.year) meta.push(esc(it.year));
    if (it.rating) meta.push('<span class="r">★ ' + esc(it.rating) + '</span>');
    if (it.time && !it.is_series) meta.push(esc(it.time) + ' min');
    if (it.genres) meta.push(esc(it.genres));
    $('d-meta').innerHTML = meta.join(' &nbsp;·&nbsp; ');
    $('d-desc').innerHTML = esc(it.description) +
      (it.director ? '<br><br>Director: ' + esc(it.director) : '') + (it.actors ? '<br>Cast: ' + esc(it.actors) : '');
    setZone('detail');
    buildMain();

    if (it.is_series) {
      api('/api/vod/children', { movie_id: it.id, season_id: 0 }, function (err, res) {
        if (S.detail !== d) return;
        if (err) return toast(err);
        var seasons = res.items || [], acts = [];
        for (var i = 0; i < seasons.length; i++) acts.push(seasonAction(it, seasons[i]));
        if (!acts.length) acts.push({ label: 'No episodes found', fn: function () {} });
        d.extra = acts;
        if (!d.stack.length) buildMain();
      });
    }
  }

  // A play request "o": { item, key (resume key), label, ref (params for /api/vod/play), start, next }
  function buildMain() {
    var d = S.detail, it = d.item, list = [], r = recentFor(it.id);
    if (it.is_series) {
      if (r && r.pos > 0 && r.ref) list.push({ label: '▶ Resume ' + r.label + ' · ' + fmt(r.pos), fn: function () {
        playVod({ item: it, key: r.key, label: r.label, ref: r.ref, start: r.pos });
      } });
      list = list.concat(d.extra || [{ label: 'Loading seasons…', fn: function () {} }]);
    } else {
      var res = resumeOf(it.id), resumable = res && res.pos > 30;
      var base = function (start) {
        return { item: it, key: it.id, label: it.name, ref: { movie_id: it.id }, start: start };
      };
      if (resumable) list.push({ label: '▶ Resume from ' + fmt(res.pos), fn: function () { playVod(base(res.pos)); } });
      list.push({ label: resumable ? '↺ Play from start' : '▶ Play', fn: function () { playVod(base(0)); } });
    }
    list.push({ label: isFav(it) ? '✓ In My List' : '+ Add to My List', fn: function () { toggleFav(it); buildMain(); } });
    d.list = list;
    d.idx = Math.min(d.idx, list.length - 1);
    d.crumb = '';
    drawDetail();
  }

  function seasonAction(it, season) {
    return { label: season.name + '  ›', fn: function () {
      toast('Loading…', true);
      api('/api/vod/children', { movie_id: it.id, season_id: season.id }, function (err, res) {
        hideToast();
        if (err) return toast(err);
        var eps = (res.items || []).slice();
        eps.sort(function (a, b) { return (+a.series_number || 0) - (+b.series_number || 0); });
        pushList(season.name, function () { return episodeActions(it, season, eps); });
      });
    } };
  }

  function episodeActions(it, season, eps) {
    var acts = [];
    function play(j, start) {
      var e = eps[j];
      playVod({ item: it, key: it.id + ':' + e.id, label: season.name + ' · ' + e.name, start: start,
        ref: { movie_id: it.id, season_id: season.id, episode_id: e.id, series: e.series_number },
        next: j + 1 < eps.length ? function () { play(j + 1, 0); } : null });
    }
    for (var j = 0; j < eps.length; j++) {
      (function (j) {
        var r = resumeOf(it.id + ':' + eps[j].id);
        acts.push({ label: eps[j].name + (r ? '  · ' + fmt(r.pos) : ''), prog: r && r.len ? r.pos / r.len : 0,
          fn: function () { play(j, r ? r.pos : 0); } });
      })(j);
    }
    return acts;
  }

  function pushList(crumb, build) {
    var d = S.detail;
    d.stack.push({ list: d.list, idx: d.idx, crumb: d.crumb, rebuild: d.rebuild });
    d.list = build(); d.idx = 0; d.crumb = crumb; d.rebuild = build;
    drawDetail();
  }

  function drawDetail() {
    var d = S.detail, h = '';
    for (var i = 0; i < d.list.length; i++) {
      var a = d.list[i];
      h += '<div class="act' + (i === d.idx ? ' focus' : '') + '" id="a' + i + '">' + esc(a.label) +
        (a.prog ? '<div class="pr" style="width:' + Math.round(a.prog * 100) + '%"></div>' : '') + '</div>';
    }
    $('d-list').innerHTML = h;
    $('d-crumb').innerHTML = esc(d.crumb);
    $('d-list').scrollTop = 0;
    ensureVisible($('d-list'), $('a' + d.idx), 52);
  }

  function detailKey(k) {
    var d = S.detail, n = d.list.length;
    if (k === K.UP && d.idx > 0) d.idx--;
    else if (k === K.DOWN && d.idx < n - 1) d.idx++;
    else if (k === K.PGDN) d.idx = Math.min(n - 1, d.idx + 6);
    else if (k === K.PGUP) d.idx = Math.max(0, d.idx - 6);
    else if (k === K.OK || k === K.RIGHT) { if (d.list[d.idx]) d.list[d.idx].fn(); return; }
    else if (k === K.BLUE) { toggleFav(d.item); return; }
    else if (k === K.BACK || k === K.LEFT) {
      if (d.stack.length) {
        var s = d.stack.pop();
        d.list = s.list; d.idx = s.idx; d.crumb = s.crumb; d.rebuild = s.rebuild;
        drawDetail();
      } else {
        S.detail = null;
        setZone('grid');
        refreshTile();
      }
      return;
    } else return;
    drawDetail();
  }

  function refreshTile() {
    var g = S.grid, el = $('t' + g.idx);
    if (!el || g.kind !== 'vod') return;
    var div = document.createElement('div');
    div.innerHTML = tileHtml(g.items[g.idx], g.idx, g.kind);
    var fresh = div.firstChild;
    fresh.className += ' focus';
    el.parentNode.replaceChild(fresh, el);
  }

  // ---------------------------------------------------------------- player
  var P = { o: null, prevZone: 'grid', paused: false, seekTo: null, seekTimer: null, osdTimer: null, tick: null, started: false };
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

  P.open = function (url, o) {
    if (P.o) P.stop();
    if (S.zone !== 'player') P.prevZone = S.zone;
    P.o = o; P.url = url; P.paused = false; P.started = false; P.seekTo = null; P.resumeTo = null;
    setZone('player');
    setFlag('playing', true);
    setFlag('live', o.kind === 'live');
    P.osd(true, 'Loading…');
    if (MAG) gSTB.Play('ffmpeg ' + url);
    else { video.src = url; video.play(); }
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
    if (P.o && P.o.kind === 'vod' && P.started && P.resumeTo == null) saveProgress(P.o, P.pos(), P.len());
    clearInterval(P.tick); clearTimeout(P.seekTimer); clearTimeout(P.osdTimer);
    if (MAG) { try { gSTB.Stop(); } catch (e) { /* ignore */ } }
    else { video.pause(); video.removeAttribute('src'); video.load(); }
    if (P.url && P.o && P.o.kind === 'vod') api('/api/vod/release', { url: P.url }, function () {});
    P.url = null;
  };

  P.close = function () {
    P.stop();
    P.o = null;
    setFlag('playing', false); setFlag('osd', false); setFlag('live', false);
    setZone(P.prevZone);
    if (S.zone === 'detail') rebuildDetail();
    else if (S.zone === 'grid') refreshTile();
  };

  P.event = function (code) {
    if (!P.o) return;
    if (code === 4 && !P.started) {           // playback started
      P.onStarted();
    } else if (code === 1) {                  // end of stream
      var o = P.o;
      if (o.kind === 'vod') saveProgress(o, P.len() || 1, P.len() || 1);
      if (o.next) { P.stop(); o.next(); } else P.close();
    } else if (code === 5) {                  // could not open
      toast('Playback failed');
      P.close();
    }
  };

  P.onStarted = function () {
    P.started = true;
    P.resumeTo = P.o.start > 5 ? P.o.start : null;
    P.resumeTries = 0;
    P.osd(true);
  };

  // Seek to the resume point once the stream knows its length; re-try until the position lands.
  P.applyResume = function () {
    if (P.resumeTo == null || !(P.len() > 0)) return;
    if (Math.abs(P.pos() - P.resumeTo) < 20 || P.resumeTries >= 6) { P.resumeTo = null; return; }
    P.resumeTries++;
    P.seek(P.resumeTo);
  };

  P.osd = function (show, state) {
    setFlag('osd', show);
    P.state = state || '';
    clearTimeout(P.osdTimer);
    if (show) {
      P.drawOsd();
      if (!P.paused && !state) P.osdTimer = setTimeout(function () { setFlag('osd', false); }, 4000);
    }
  };

  P.drawOsd = function () {
    var o = P.o; if (!o) return;
    var len = P.len(), pos = P.seekTo != null ? P.seekTo : P.pos();
    $('osd-title').innerHTML = esc(o.kind === 'vod' && o.label !== o.item.name ? o.item.name + ' — ' + o.label : o.label);
    $('osd-fill').style.width = len ? Math.min(100, 100 * pos / len) + '%' : '0';
    $('osd-time').innerHTML = fmt(pos) + ' / ' + fmt(len);
    $('osd-state').innerHTML = esc(P.state || (P.seekTo != null ? 'Seeking…' : P.paused ? '❚❚ Paused' : '▶ Playing'));
  };

  P.nudge = function (delta) {
    if (!P.started) return;
    var len = P.len(), base = P.seekTo != null ? P.seekTo : P.pos();
    P.seekTo = Math.max(0, Math.min(len ? len - 5 : base + delta, base + delta));
    P.osd(true);
    clearTimeout(P.seekTimer);
    P.seekTimer = setTimeout(function () { P.seek(P.seekTo); P.seekTo = null; P.osd(true); }, 800);
  };

  P.toggle = function () {
    P.paused = !P.paused;
    if (MAG) { if (P.paused) gSTB.Pause(); else gSTB.Continue(); }
    else if (P.paused) video.pause(); else video.play();
    P.osd(true);
  };

  function playerKey(k) {
    var live = P.o && P.o.kind === 'live';
    if (k === K.BACK || k === K.STOP) return P.close();
    if (k === K.INFO) return P.osd(!S.flags.osd);
    if (live) {
      if (k === K.UP || k === K.PGUP) return zap(-1);
      if (k === K.DOWN || k === K.PGDN) return zap(1);
      if (k === K.OK) return P.osd(true);
      return;
    }
    if (k === K.OK || k === K.PLAY) P.toggle();
    else if (k === K.LEFT) P.nudge(-30);
    else if (k === K.RIGHT) P.nudge(30);
    else if (k === K.REW) P.nudge(-120);
    else if (k === K.FFWD) P.nudge(120);
    else if (k === K.DOWN) P.nudge(-300);
    else if (k === K.UP) P.nudge(300);
  }

  function rebuildDetail() {
    var d = S.detail;
    if (!d) return;
    if (!d.stack.length) return buildMain();
    var idx = d.idx;
    d.list = d.rebuild();
    d.idx = Math.min(idx, d.list.length - 1);
    drawDetail();
  }

  function playVod(o) {
    o.kind = 'vod';
    toast('Loading…', true);
    api('/api/vod/play', o.ref, function (err, res) {
      hideToast();
      if (err || !res.url) return toast(err || 'No stream available');
      P.open(res.url, o);
    });
  }

  function playLive(i) {
    var ch = S.grid.items[i];
    if (!ch) return;
    if (S.zone === 'grid') focusTile(i);
    api('/api/live/link', { cmd: ch.cmd }, function (err, res) {
      if (err || !res.url) return toast(err || 'Channel unavailable');
      P.open(res.url, { kind: 'live', label: ch.number + '  ' + ch.name, idx: i });
    });
  }

  function zap(delta) {
    var i = P.o.idx + delta, n = S.grid.items.length;
    if (i < 0 || i >= n) return;
    P.o.idx = i;
    P.osd(true, S.grid.items[i].number + '  ' + S.grid.items[i].name);
    playLive(i);
  }

  // ------------------------------------------------------------------ keys
  var handlers = { tabs: tabsKey, cats: catsKey, search: searchKey, find: findKey, grid: gridKey, detail: detailKey, player: playerKey };
  // Map raw key events to K.* (MAG sends media keys as Alt+letter, CH+/- as Tab).
  function normKey(e) {
    var c = e.keyCode;
    if (c === 9) return e.shiftKey ? K.PGDN : K.PGUP;
    if (e.altKey) return c === 80 ? K.INFO : c;               // Alt+R/S/B/F/P
    if (c === 8) return (S.zone === 'search' || S.zone === 'find') ? 8 : K.BACK;  // Backspace edits the search text
    if (MAG && (c === 82 || c === 83 || c === 66 || c === 70 || c === 89)) return 0; // plain letters
    return c;
  }
  // Search-as-you-type: debounce so we don't hit the API on every keystroke.
  var liveTimer;
  function scheduleLive() { clearTimeout(liveTimer); liveTimer = setTimeout(liveSearch, 300); }
  function liveSearch() {
    if (S.zone === 'find') {
      var q = $('find').value.replace(/^\s+|\s+$/g, '');
      if (q.length >= 2) runFind(q, true);
      else if (!q && S.flags.scoped) clearFind();
    } else if (S.zone === 'search') {
      var s = $('search').value.replace(/^\s+|\s+$/g, '');
      if (s.length >= 2) runSearch(s);
      else setGrid(null, 'Type to search all movies & series');
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 112 && S.zone !== 'search') {   // Red button: reload the portal
      if (P.o) P.stop();
      location.reload();
      return;
    }
    var h = handlers[S.zone];
    if (h && h(normKey(e), e) === false) { scheduleLive(); return; }  // typing fell through
    e.preventDefault();
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
    var d = new Date();
    $('clock').innerHTML = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  scale();
  window.addEventListener('resize', scale, false);
  clock(); setInterval(clock, 15000);
  P.init();
  bodyClass();
  selectTab(0);
  setZone('cats');
})();
