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
    GREEN: 113                    // Ctrl+F2 on MAG: audio & subtitles while playing
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
    if (window.fkTransport) return fkTransport.api(path, params || {}, cb);   // TV build only
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
    if (window.fkTransport) return fkTransport.state();                        // TV build only
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
    if (window.fkTransport && z !== S.zone) fkTransport.zone(z);     // TV build only: history for Back
    S.zone = z;
    bodyClass();
    var input = z === 'search' ? $('search') : z === 'find' ? $('find') : z === 'pin' ? $('pin') : null;
    if (input) {
      input.focus();                             // CSS docks the field low; the keyboard follows it
      try { if (MAG && gSTB.ShowVirtualKeyboard) gSTB.ShowVirtualKeyboard(); } catch (e) { /* n/a */ }
    } else {
      var a = document.activeElement;
      if (a && (a.id === 'search' || a.id === 'find' || a.id === 'pin')) {
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
    if (!o || !o.key || !(pos > 0) || (o.item && o.item.adult)) return;   // adult titles never go in Continue watching
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
    if (S.cats[i].adult) return adultAction(S.cats[i].adult);
    setFlag('cansearch', tab === 'vod');
    setFlag('scoped', false);
    if (tab === 'vod') {
      S.curCat = S.cats[i];
      $('find').value = '';
      $('find').placeholder = 'Search in ' + S.curCat.title;
      setGrid(remote('/api/vod/list', { category: id }), null, 5, 'vod');
    }
    else if (tab === 'live') {
      if (S.cats[i].group) return liveDrill(S.cats[i].group);     // group row: show its genres
      if (S.cats[i].back) return liveTop();                       // back row: show the groups
      setGrid(remote('/api/live/channels', { genre: id }), null, 4, 'live');
    }
    else if (tab === 'mine') {
      var list = id === 'favs' ? favs() : (function () {
        var r = load('recent', []), out = [];
        for (var j = 0; j < r.length; j++) if (!r[j].item.adult) out.push(r[j].item);
        return out;
      })();
      setGrid(local(list), id === 'favs' ? 'Press ■ BLUE on any title to add it here' : 'Nothing watched yet', 5, 'vod');
    }
  }

  // Live TV is two levels: groups (ENGLISH, SPORTS...) then genres. Group and back
  // rows open a list instead of a channel grid, so they never auto-select.
  function isNav(c) { return !!(c && (c.group || c.back || c.adult)); }

  // Adult rows: "unlock" asks for the PIN, "lock" locks again right away.
  var pinOk = false;
  function adultAction(kind) {
    if (kind === 'lock') {
      api('/api/adult/lock', {}, function (err) {
        if (err) return toast(err);
        toast('Adult content locked');
        selectTab(S.tab);
      });
      return;
    }
    $('pin').value = '';
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
      if (ok) { toast('Adult content unlocked'); selectTab(S.tab); }
      return;
    }
    if (k === K.OK) {
      api('/api/adult/unlock', { pin: input.value }, function (err) {
        if (err) { toast(err); input.value = ''; return; }
        leavePin(true);
      });
      return;
    }
    return false;                               // digits go into the PIN field
  }
  function liveDrill(key) {
    api('/api/live/genres', { group: key }, function (err, list) {
      if (err) return toast(err);
      S.cats = list;
      S.cat = S.catFocus = list.length > 1 ? 1 : 0;               // first genre under the back row
      $('cats').scrollTop = 0;
      drawCats();
      setGrid(null, 'Pick a genre on the left', 4, 'live');
    });
  }
  function liveTop() {
    api('/api/live/genres', {}, function (err, list) {
      if (err) return toast(err);
      setCats(list);                                              // selects All and loads its channels
    });
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
      if (isNav(S.cats[S.catFocus])) { selectCat(S.catFocus); return; }   // stay in the list
      if (S.cat !== S.catFocus) selectCat(S.catFocus);
      return setZone('grid');
    } else if (k === K.BACK) return setZone('tabs');
    else return;
    drawCats();
    clearTimeout(catTimer);
    catTimer = setTimeout(function () {
      if (S.cat !== S.catFocus && !isNav(S.cats[S.catFocus])) selectCat(S.catFocus);
    }, 450);
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
      list.push({ label: resumable ? 'Play from start' : '▶ Play', fn: function () { playVod(base(0)); } });
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
    if (window.fkTransport) fkTransport.subtitleOff();   // no subtitle carries over to the next title
    if (P.o) P.stop();
    if (S.zone !== 'player') P.prevZone = S.zone;
    P.o = o; P.url = url; P.paused = false; P.started = false; P.seekTo = null; P.resumeTo = null;
    // Track selections (subtitles off by default). hlsSubs is null until the menu is first
    // opened: we don't ask the provider for the track list during normal playback.
    // TV: portal streams start their video 600 s into the timeline, while the
    // subtitles start at 0, so the TV starts 600 s early. The Delay row adjusts from there.
    P.subSel = -1; P.subShift = window.fkTransport ? -600 : 0; P.audPid = null; P.hlsSubs = null;
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
      // Say when it failed: before the stream started, or after (e.g. during a resume seek).
      var when = !P.started ? 'while opening' : (P.resumeTo != null ? 'while resuming at ' + fmt(P.resumeTo) : 'during playback');
      toast('Playback failed ' + when);
      P.close();
    }
  };

  P.onStarted = function () {
    P.started = true;
    // TV: start loading the subtitles now, so the Green menu opens quickly.
    if (window.fkTransport && P.o && P.o.kind === 'vod' && P.url) {
      fkTransport.api('/api/vod/subs', { url: P.url }, function () {});
    }
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
    if (k === K.GREEN) return P.openMenu();
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

  // --- audio & subtitle menu (during playback) ---
  function tracks(fn) {
    var r;
    try { r = gSTB[fn](); } catch (e) { return []; }
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return []; } }
    return r && r.length ? r : [];
  }
  function trackLabel(t, i) {
    return esc(t.lang || t.name || t.title || ('Track ' + (i + 1)));
  }

  function delayLabel() {
    var v = P.subShift || 0;
    return 'Delay ' + (v > 0 ? '+' : '') + v.toFixed(2) + 's   LEFT/RIGHT 0.25s   CH 30s';
  }
  function buildMenuItems() {
    var items = [{ head: 'AUDIO' }];
    var a = tracks('GetAudioPIDs');
    if (!a.length) items.push({ dead: 'Default' });
    for (var i = 0; i < a.length; i++) items.push({ kind: 'audio', pid: a[i].pid, label: trackLabel(a[i], i) });
    items.push({ head: 'SUBTITLES' });
    items.push({ kind: 'sub', sub: -1, label: 'Off' });
    // Subtitles come from the stream's HLS tracks (merged to SRT by the server),
    // because this firmware doesn't expose them via GetSubtitlePIDs.
    var subs = P.hlsSubs || [];
    for (var j = 0; j < subs.length; j++) {
      items.push({ kind: 'sub', sub: j, label: esc(subs[j].name || subs[j].lang || ('Subtitles ' + (j + 1))) });
    }
    if (!subs.length) items.push({ dead: 'None in this title' });
    if (P.subSel >= 0) items.push({ kind: 'delay' });     // adjust sync once a track is on
    return items;
  }
  P.openMenu = function () {
    if ((!MAG && !window.fkTransport) || !P.o) return;
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
    if (P.audPid == null) { try { P.audPid = parseInt(gSTB.GetAudioPID(), 10); } catch (e) { P.audPid = null; } }
    P.menu = { items: buildMenuItems() };
    P.menu.idx = menuStep(-1, 1);
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
    var it = P.menu.items, h = '';
    for (var i = 0; i < it.length; i++) {
      if (it[i].head) h += '<div class="pm-head">' + esc(it[i].head) + '</div>';
      else if (it[i].dead) h += '<div class="pm-dead">' + esc(it[i].dead) + '</div>';
      else {
        var label = it[i].kind === 'delay' ? delayLabel() : it[i].label;
        h += '<div class="pm-item' + (i === P.menu.idx ? ' focus' : '') + '"><span class="chk">' +
          (menuCurrent(it[i]) ? '✓' : '') + '</span>' + label + '</div>';
      }
    }
    $('pmenu').innerHTML = h;
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
      if (announce) { toast((P.hlsSubs[sel].name || 'Subtitles') + ' on'); rebuildMenu(); }
    });
  }
  function applySub(sel, announce) {
    if (window.fkTransport) return applySubTv(sel, announce);         // warm the server merge, then hand the SRT to the player
    var url = subUrl(sel);
    if (announce) toast('Loading subtitles…', true);
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (announce) hideToast();
      if (x.status !== 200) { toast('Could not load subtitles'); return; }
      try {
        gSTB.LoadExternalSubtitles(url);
        gSTB.SetSubtitles(true);
        P.subSel = sel;
        if (announce) { toast((P.hlsSubs[sel].name || 'Subtitles') + ' on'); rebuildMenu(); }
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
    if (it.kind === 'audio') {
      try { gSTB.SetAudioPID(it.pid); P.audPid = it.pid; } catch (e) { /* n/a */ }
      drawMenu();
    } else if (it.kind === 'sub') {
      if (it.sub === -1) {
        try { gSTB.SetSubtitles(false); } catch (e) { /* n/a */ }
        if (window.fkTransport) fkTransport.subtitleOff();
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
  var handlers = { tabs: tabsKey, cats: catsKey, search: searchKey, find: findKey, grid: gridKey, detail: detailKey, player: playerKey, pmenu: pmenuKey, pin: pinKey };
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
      var q = $('find').value.replace(/^\s+|\s+$/g, '');
      if (q.length >= 2) runFind(q, true);
      else if (!q && S.flags.scoped) clearFind();
    } else if (S.zone === 'search') {
      var s = $('search').value.replace(/^\s+|\s+$/g, '');
      if (s.length >= 2) runSearch(s);
      else setGrid(null, 'Type to search all movies & series');
    }
  }

  // Keys the UI consumes (normalised). Anything else — volume, mute, power —
  // is left for the MAG firmware to handle, so we must NOT preventDefault it.
  var USED = {};
  [K.LEFT, K.UP, K.RIGHT, K.DOWN, K.OK, K.BACK, K.PGUP, K.PGDN,
   K.PLAY, K.STOP, K.REW, K.FFWD, K.INFO, K.RED, K.BLUE, 113, 114].forEach(function (c) { USED[c] = 1; });

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

  document.addEventListener('keydown', function (e) {
    if ((e.keyCode === 112 || e.keyCode === 403) && S.zone !== 'search') {   // Red button (403 on webOS): reload the portal
      if (P.o) P.stop();
      location.reload();
      return;
    }
    if (e.keyCode === 107) { setVol(5); e.preventDefault(); return; }   // Volume Up
    if (e.keyCode === 109) { setVol(-5); e.preventDefault(); return; }  // Volume Down
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
