// fresh4k TV transport. Loaded before web/app.js in the TV build only.
// app.js calls fkTransport in place of its /api/ XHR calls, and reads the
// key map instead of MAG key codes.
(function () {
  'use strict';
  var SVC = 'luna://com.fresh4k.app.service';

  function call(method, params, cb) {
    if (!window.webOS || !webOS.service) return cb('webOS.service not available');
    webOS.service.request(SVC, {
      method: method, parameters: params,
      onSuccess: function (r) {
        if (r.returnValue === false) return cb(r.errorText || 'service error');
        cb(null, r);
      },
      onFailure: function (r) { cb(r.errorText || 'service failed'); }
    });
  }

  var STATE_KEY = 'fk_state';
  window.fkTransport = {
    // GET /api/...: cb(errorText) or cb(null, data)
    api: function (path, params, cb) {
      call('api', { path: path, params: params }, function (err, r) {
        if (err) return cb(err);
        cb(null, r.data);
      });
    },
    // Favorites and resume points: synchronous, kept in local storage on the TV.
    state: function () {
      try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { return {}; }
    },
    saveState: function (body) {
      var s = this.state();
      for (var k in body) if (body.hasOwnProperty(k)) s[k] = body[k];
      try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* storage full: keep going */ }
    }
  };

  // Back works like the browser's back: it pops history, and only leaves the app
  // when there is no history left. The app moves between screens without history,
  // so app.js calls zone() on each screen change and we record it here. When an
  // entry is popped, we replay the app's BACK action; that replay records nothing.
  var depth = 0, pending = 0, replaying = false;
  window.fkTransport.zone = function () {
    if (replaying) return;
    history.pushState({ fk: ++depth }, '');
  };
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if ((k === 461 || k === 413) && depth - pending > 0) {   // Back or Stop, with screens to return to
      e.preventDefault();
      e.stopImmediatePropagation();
      pending++;
      history.back();
    }
  }, true);
  function replayBack() {
    replaying = true;
    var ev = document.createEvent('Event');
    ev.initEvent('keydown', true, true);
    ev.keyCode = 27;
    document.dispatchEvent(ev);
    replaying = false;
  }
  window.addEventListener('popstate', function () {
    if (depth > 0) depth--;
    if (pending > 0) pending--;
    replayBack();
  }, false);
  // Leave the current screen the way Back would (the PIN prompt uses this on submit).
  window.fkTransport.back = function () {
    if (depth - pending > 0) { pending++; history.back(); }
    else replayBack();
  };

  // Subtitles: the service merges the stream's HLS subtitle track into WebVTT;
  // the TV's <video> shows it through a <track> element.
  window.fkTransport.subtitle = function (streamUrl, track, shift, cb) {
    call('api', { path: '/api/vod/subtitle', params: { url: streamUrl, track: track, shift: shift } },
      function (err, r) {
        if (err) return cb(err);
        cb(null, r.data && r.data.vtt);
      });
  };
  window.fkTransport.subtitleOff = function () {
    var v = document.getElementById('video');
    if (!v) return;
    var old = v.getElementsByTagName('track');
    for (var i = old.length - 1; i >= 0; i--) v.removeChild(old[i]);
  };
  window.fkTransport.setSubtitles = function (vtt) {
    this.subtitleOff();
    var v = document.getElementById('video');
    if (!v || !window.URL || !URL.createObjectURL) return false;
    var t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = 'Subtitles';
    t.srclang = 'en';
    t.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    v.appendChild(t);
    if (t.track) t.track.mode = 'showing';
    return true;
  };

  // Key-code readout for finding remote codes: shows each key press in a yellow
  // box for 4 seconds. Off by default. To use it, remove the /* and */ lines.
  /*
  var dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:9999;font:28px monospace;' +
    'background:rgba(0,0,0,.8);color:#ff0;padding:8px 14px;border-radius:6px;display:none';
  var dbgTimer;
  document.addEventListener('keydown', function (e) {
    if (!document.body) return;
    if (!dbg.parentNode) document.body.appendChild(dbg);
    dbg.textContent = 'key ' + e.keyCode + (e.key ? '  ' + e.key : '');
    dbg.style.display = 'block';
    clearTimeout(dbgTimer);
    dbgTimer = setTimeout(function () { dbg.style.display = 'none'; }, 4000);
  }, true);
  */

  // On-screen hints: show the TV's buttons, not the MAG's.
  function fixHints() {
    var hint = document.getElementById('hint');
    if (hint) hint.innerHTML = hint.innerHTML.replace('BACK return', 'STOP back');
    var osd = document.getElementById('osd-hint');
    if (osd) osd.textContent = 'GREEN: subtitles   STOP: back   LEFT/RIGHT: 30s   UP/DOWN: 5 min   OK: pause';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fixHints, false);
  else fixHints();

  // webOS remote -> the key codes app.js uses (K.* in app.js).
  window.fkKeyMap = {
    403: 112,   // Red             -> RED
    404: 113,   // Green           -> GREEN
    406: 115,   // Blue            -> BLUE
    415: 82,    // Play            -> PLAY
    19:  82,    // Pause           -> PLAY (toggle)
    // webOS handles the Back key itself (it asks "exit the app?") and the page
    // never receives it. Stop reaches the page, so it acts as Back on the TV.
    413: 27,    // Stop            -> BACK (closes the player too)
    412: 66,    // Rewind          -> REW
    417: 70,    // Fast forward    -> FFWD
    33:  34,    // Channel up (sent as PageUp, 33)   -> PGDN (next channel in Live TV)
    34:  33,    // Channel down (sent as PageDown, 34) -> PGUP (previous channel)
    457: 89     // Info            -> INFO
  };
})();
