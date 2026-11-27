#!/usr/bin/env python3
"""fresh4k mini portal.

Serves a lightweight remote-friendly UI for MAG set-top boxes and proxies the
provider's Stalker/Ministra API (MAC-based auth), so the box itself only ever
talks to this server for UI + metadata. Streams are played directly from the
provider by the box.

Python 3.7+, standard library only.

    python3 server.py                 # uses config.json
    MOCK=1 python3 server.py          # fake data, for testing in a browser
"""
import concurrent.futures
import hashlib
import html
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

# Adult content is locked by default. Same rule as tv/app/service/services.js:
# categories (and live genres) whose title matches this are hidden everywhere.
ADULT_TITLE = re.compile(r"adult|18\+|xxx|porn", re.I)
# Titles the portal marks as pre-release DVD prints, e.g. "Max (PREDVD)" or "(PRE DVD)".
PREDVD_TITLE = re.compile(r"PRE\s*DVD", re.I)
# The provider updates movies and series once a day, so VOD catalog answers are kept
# for 24h. The red button clears them first (GET /api/cache/clear), then reloads.
# Mirrored in tv/app/service/services.js and web/app.js.
VOD_TTL = 24 * 3600
# Only the first pages of a list or search are cached; deeper pages always go to the portal.
VOD_LIST_PAGES_CACHED = 5
# Memory limits: the oldest entries go first when a cache is full. A portal page is a
# few KB; a subtitle track can be a few hundred KB, so that cache is kept smaller.
CACHE_MAX = 300
SUB_CACHE_MAX = 40


def remember(cache, key, value, limit):
    """Store key -> value, keeping the dict at most `limit` long (oldest dropped).
    Callers hold the cache lock."""
    cache.pop(key, None)
    cache[key] = value
    while len(cache) > limit:
        del cache[next(iter(cache))]


def group_live(genres):
    """Two-level Live TV menu. Returns (top, subs):
      top  - All, then one row per group (ENGLISH (21) >, SPORTS (25) >, ...)
      subs - {group: [genres in that group]}; a group with one genre goes to OTHER.
    Mirrored in tv/app/service/services.js."""
    top, groups, order, subs = [], {}, [], {}
    for g in genres:
        if g["id"] == "*":                           # "All" stays on top
            top.append(g)
            continue
        parts = g["title"].split("|")
        key = parts[0].strip().upper() or "OTHER"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append((g, parts))
    others = []
    for key in sorted(order):                       # groups and their genres sorted by name
        items = groups[key]
        if len(items) >= 2:
            subs[key] = [{"id": g["id"], "title": " | ".join(p.strip() for p in parts[1:]).strip() or key}
                         for g, parts in items]
        else:
            others.extend(g for g, _ in items)
    if others:
        subs.setdefault("OTHER", []).extend(others)
    for key in subs:
        subs[key].sort(key=lambda t: t["title"].upper())
    for key in sorted(order) + ["OTHER"]:
        if key in subs and not any(t.get("group") == key for t in top):
            top.append({"id": "grp:" + key, "title": "%s (%d)  >" % (key, len(subs[key])), "group": key})
    return top, subs

DEFAULTS = {
    "portal": "http://fresh4k.cc",
    "api_path": "/stalker_portal/server/load.php",
    "mac": "",
    "port": 8080,
    "timezone": "Europe/London",
    "model": "MAG544",
    "link": "WiFi",
    "sn": "",
    "device_id": "",
    "device_id2": "",
    "signature": "",
    "hw_version": "",
    "hw_version_2": "",
    "user_agent": ("Mozilla/5.0 (Unknown; Linux) AppleWebKit/538.1 (KHTML, like Gecko) "
                   "MAG200 stbapp ver: 4 rev: 734 Mobile Safari/538.1"),
    # Optional: category IDs to show in Movies & Series, in this order.
    # Empty list = show every category the provider offers.
    "vod_categories": [],
    # Optional: group the menu under section headers, e.g.
    # [{"title": "HINDI", "ids": ["19", "15"]}, ...]. Takes precedence over
    # vod_categories. Empty = no grouping.
    "vod_groups": [],
    "mock": False,
}


def load_config():
    cfg = dict(DEFAULTS)
    path = os.path.join(ROOT, "config.json")
    if os.path.exists(path):
        with open(path) as f:
            cfg.update(json.load(f))
    for key in DEFAULTS:
        env = os.environ.get(key.upper())
        if env is not None:
            cfg[key] = env
    cfg["port"] = int(cfg["port"])
    cfg["mock"] = str(cfg["mock"]).lower() in ("1", "true", "yes")
    cfg["mac"] = cfg["mac"].upper()
    return cfg


class AuthError(Exception):
    pass


class Stalker:
    """Minimal Stalker portal client authenticating as a MAG box."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.base = cfg["portal"].rstrip("/")
        self.endpoint = self.base + cfg["api_path"]
        self.token = None
        self.lock = threading.Lock()
        self.cache = {}                             # portal answers: key -> (expires, result)
        self.sub_cache = {}                         # subtitle cues: key -> cues
        self.cache_lock = threading.Lock()          # guards both dicts (requests run in threads)
        self.cache_started = time.time()            # the whole cache is emptied every 24h
        self.adult_unlocked = False                 # set by the PIN; resets when the server restarts

    # -- transport ---------------------------------------------------------
    def _request(self, params):
        params = dict(params, JsHttpRequest="1-xml")
        url = self.endpoint + "?" + urllib.parse.urlencode(params)
        headers = {
            "User-Agent": self.cfg["user_agent"],
            "X-User-Agent": "Model: %s; Link: %s" % (self.cfg["model"], self.cfg["link"]),
            "Referer": self.base + "/stalker_portal/c/",
            "Accept": "*/*",
            "Cookie": "mac=%s; stb_lang=en; timezone=%s" % (
                urllib.parse.quote(self.cfg["mac"]),
                urllib.parse.quote(self.cfg["timezone"])),
        }
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise RuntimeError("portal HTTP %s: %s" % (e.code, e.read()[:200]))
        if "Authorization failed" in body:
            raise AuthError(body[:200])
        try:
            data = json.loads(body)
        except ValueError:
            raise RuntimeError("portal returned non-JSON: %r" % body[:200])
        return data.get("js") if isinstance(data, dict) else data

    def login(self):
        """Handshake + get_profile. Only device_id and device_id2 are required.

        sn, hw_version, hw_version_2 and signature are optional: they are sent
        only when set in config.json. Everything else the MAG's own portal sends
        was tested and found unnecessary (see README).
        """
        self.token = None
        js = self._request({"type": "stb", "action": "handshake", "token": "", "prehash": "false"})
        self.token = js["token"]
        c = self.cfg
        params = {"type": "stb", "action": "get_profile", "stb_type": c["model"],
                  "device_id": c["device_id"], "device_id2": c["device_id2"]}
        for key in ("sn", "hw_version", "hw_version_2", "signature"):
            if c.get(key):
                params[key] = c[key]
        profile = self._request(params)
        status = str((profile or {}).get("status", "0"))
        if status != "0":
            raise RuntimeError("portal login refused (status %s): %s" % (status, profile.get("msg", "")))

    def _expire_if_due(self):
        """Empty every cache once 24h have passed since the last clear. Caller holds cache_lock."""
        if time.time() - self.cache_started >= VOD_TTL:
            self.cache = {}
            self.sub_cache = {}
            self.cache_started = time.time()

    def call(self, params, ttl=0):
        key = tuple(sorted(params.items()))
        if ttl:
            with self.cache_lock:
                self._expire_if_due()
            hit = self.cache.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
        with self.lock:
            if not self.token:
                self.login()
        try:
            result = self._request(params)
        except AuthError:
            with self.lock:
                self.login()
            result = self._request(params)
        if ttl:
            with self.cache_lock:
                if len(self.cache) >= CACHE_MAX:          # full: drop what has expired first
                    now = time.time()
                    for k in [k for k, v in self.cache.items() if v[0] <= now]:
                        del self.cache[k]
                remember(self.cache, key, (time.time() + ttl, result), CACHE_MAX)
        return result

    def clear_cache(self):
        """Forget every cached portal answer and subtitle, so the next request goes to the provider."""
        with self.cache_lock:
            self.cache = {}
            self.sub_cache = {}
            self.cache_started = time.time()
        return {"ok": True}

    # -- helpers -----------------------------------------------------------
    def abs_url(self, uri):
        if not uri:
            return ""
        if uri.startswith("http"):
            return uri
        return self.base + ("" if uri.startswith("/") else "/") + uri

    @staticmethod
    def clean_cmd(cmd):
        return re.sub(r"^(ffmpeg|ffrt\d?|auto)\s+", "", (cmd or "").strip())

    def _page(self, js, mapper):
        js = js or {}
        return {
            "total": int(js.get("total_items") or 0),
            "per_page": int(js.get("max_page_items") or 14),
            "items": [mapper(x) for x in (js.get("data") or [])],
        }

    def _vod_item(self, x):
        return {
            "id": str(x.get("id")),
            "category_id": str(x.get("category_id") or ""),
            "warn": "PREDVD" if PREDVD_TITLE.search(x.get("name") or x.get("o_name") or "") else "",
            "name": x.get("name") or x.get("o_name") or "",
            "year": x.get("year") or "",
            "rating": x.get("rating_imdb") or x.get("rating_kinopoisk") or "",
            "genres": x.get("genres_str") or "",
            "director": x.get("director") or "",
            "actors": x.get("actors") or "",
            "time": x.get("time") or "",
            "description": x.get("description") or "",
            "poster": self.abs_url(x.get("screenshot_uri")),
            "cmd": x.get("cmd") or "",
            "is_series": str(x.get("is_series", "0")) == "1",
            "is_season": bool(x.get("is_season")),
            "is_episode": bool(x.get("is_episode")),
            "is_file": bool(x.get("is_file")),
            "series_number": str(x.get("series_number") or ""),
            "series": x.get("series") or [],
        }

    # -- Adult lock --------------------------------------------------------
    # The portal's "censored" flag is 0 on everything, so lock by category:
    # titles matching ADULT_TITLE, plus config "locked_categories". Turn off
    # with "adult_lock": false in config.json. Mirrored in tv/app/service/services.js.
    def _locked_from(self, categories):
        locked = set(str(i) for i in self.cfg.get("locked_categories") or [])
        for c in categories or []:
            if ADULT_TITLE.search(c.get("title") or ""):
                locked.add(str(c.get("id")))
        return locked

    def lock_active(self):
        return self.cfg.get("adult_lock", True) and not self.adult_unlocked

    def adult_row(self):
        """Menu row to unlock or lock adult content; none unless adult_pin is set."""
        if not self.cfg.get("adult_pin"):
            return None
        if self.adult_unlocked:
            return {"id": "adult-lock", "title": "Lock adult content", "adult": "lock"}
        return {"id": "adult-unlock", "title": "Adult content (PIN)", "adult": "unlock"}

    def _adult_ids(self):
        """Adult category ids, whether or not they are unlocked right now.
        Used to keep adult titles out of Continue watching."""
        if not self.cfg.get("adult_lock", True):
            return set()
        return self._locked_from(self.call({"type": "vod", "action": "get_categories"}, ttl=VOD_TTL))

    def adult_unlock(self, pin):
        want = str(self.cfg.get("adult_pin") or "")
        if not want:
            raise RuntimeError("no adult PIN set in config.json")
        if str(pin) != want:
            raise RuntimeError("wrong PIN")
        self.adult_unlocked = True
        return {"ok": True}

    def adult_lock(self):
        self.adult_unlocked = False
        return {"ok": True}

    def locked_ids(self):
        if not self.lock_active():
            return set()
        return self._locked_from(self.call({"type": "vod", "action": "get_categories"}, ttl=VOD_TTL))

    # -- VOD ---------------------------------------------------------------
    def _vod_category_list(self):
        raw = self.call({"type": "vod", "action": "get_categories"}, ttl=VOD_TTL)
        locked = self._locked_from(raw) if self.lock_active() else set()
        cats = [{"id": str(c["id"]), "title": c["title"]} for c in raw or []
                if str(c.get("id")) != "*" and str(c.get("id")) not in locked]
        by_id = {c["id"]: c for c in cats}
        groups = self.cfg.get("vod_groups") or []
        if groups:                                   # emit section headers + their categories
            out = []
            for g in groups:
                members = [by_id[str(i)] for i in g.get("ids", []) if str(i) in by_id]
                if members:
                    out.append({"header": g.get("title", "")})
                    out.extend(members)
            return out
        wanted = [str(x) for x in self.cfg.get("vod_categories") or []]
        if wanted:                                   # keep only these, in this order
            return [by_id[i] for i in wanted if i in by_id]
        return cats

    def vod_categories(self):
        out = self._vod_category_list()
        row = self.adult_row()
        return out + [row] if row else out

    def vod_list(self, category, page, search=""):
        # category "*" searches everything; a real id scopes the search to it.
        p = {"type": "vod", "action": "get_ordered_list", "category": category or "*",
             "genre": "*", "p": page, "sortby": "added", "fav": 0}
        if search:
            p["search"] = search
        ttl = VOD_TTL if int(page) <= VOD_LIST_PAGES_CACHED else 0
        res = self._page(self.call(p, ttl=ttl), self._vod_item)
        locked = self.locked_ids()
        res["items"] = [i for i in res["items"] if i["category_id"] not in locked]
        adult = self._adult_ids()
        for i in res["items"]:
            i["adult"] = i["category_id"] in adult
        return res

    def vod_children(self, movie_id, season_id="0", episode_id="0"):
        """Drill into a title: seasons (season_id=0), episodes of a season, or
        the playable files of a movie/episode. Returns every page."""
        items, page, total = [], 1, 1
        while len(items) < total and page <= 20:
            js = self.call({"type": "vod", "action": "get_ordered_list", "category": "*",
                            "movie_id": movie_id, "season_id": season_id,
                            "episode_id": episode_id, "fav": 0, "sortby": "added",
                            "hd": 0, "not_ended": 0, "p": page}, ttl=VOD_TTL)
            res = self._page(js, self._vod_item)
            if not res["items"]:
                break
            items += res["items"]
            total = res["total"]
            page += 1
        return {"total": len(items), "per_page": len(items), "items": items}

    def vod_play(self, movie_id, season_id="0", episode_id="0", series=""):
        """Resolve a movie or episode to a stream URL (title -> file -> link)."""
        files = [f for f in self.vod_children(movie_id, season_id, episode_id)["items"]
                 if f["is_file"]]
        if not files:
            raise RuntimeError("no playable file for this title")
        js = self.call({"type": "vod", "action": "create_link",
                        "cmd": "/media/file_%s.mpg" % files[0]["id"], "series": series,
                        "forced_storage": "", "disable_ad": 0, "download": 0,
                        "force_ch_link_check": 0})
        raw = (js or {}).get("cmd") or ""
        return {"url": self.clean_cmd(raw), "cmd": raw}

    def vod_release(self, url):
        """Tell the portal we're done with a stream link (frees the stream slot)."""
        self.call({"type": "vod", "action": "del_link", "item": url})
        return {"ok": True}

    # -- Subtitles (HLS sidecar tracks the MAG firmware ignores) -----------
    def _get(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": self.cfg["user_agent"]})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", "replace")

    @staticmethod
    def _subs_from_master(text):
        subs = []
        for ln in text.splitlines():
            if "TYPE=SUBTITLES" in ln:
                name = re.search(r'NAME="([^"]*)"', ln)
                lang = re.search(r'LANGUAGE="([^"]*)"', ln)
                uri = re.search(r'URI="([^"]*)"', ln)
                if uri:
                    label = (name and name.group(1)) or (lang and lang.group(1)) or "Subtitles"
                    subs.append({"name": label, "lang": (lang and lang.group(1)) or "", "uri": uri.group(1)})
        return subs

    def vod_subs(self, url):
        """List subtitle tracks advertised in a stream's HLS master playlist."""
        try:
            subs = self._subs_from_master(self._get(url))
        except Exception:
            return []
        return [{"name": s["name"], "lang": s["lang"]} for s in subs]

    _TS = re.compile(r'(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})')

    @classmethod
    def _secs(cls, m):
        h = int(m.group(1) or 0)
        return h * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0

    @classmethod
    def _parse_vtt(cls, text):
        lines = text.splitlines()
        offset = 0.0
        for ln in lines[:6]:
            mm = re.search(r'X-TIMESTAMP-MAP=.*MPEGTS:(\d+).*LOCAL:(\d{2}):(\d{2}):(\d{2})[.,](\d{3})', ln)
            if mm:
                local = int(mm.group(2)) * 3600 + int(mm.group(3)) * 60 + int(mm.group(4)) + int(mm.group(5)) / 1000.0
                offset = int(mm.group(1)) / 90000.0 - local
        cues, i, n = [], 0, len(lines)
        while i < n:
            if '-->' in lines[i]:
                times = list(cls._TS.finditer(lines[i]))
                if len(times) >= 2:
                    start = cls._secs(times[0]) + offset
                    end = cls._secs(times[1]) + offset
                    i += 1
                    txt = []
                    while i < n and lines[i].strip() != "":
                        txt.append(re.sub(r'<[^>]+>', '', lines[i]))  # strip inline tags
                        i += 1
                    if txt:
                        cues.append((max(0.0, start), max(0.0, end), "\n".join(txt)))
                    continue
            i += 1
        return cues

    @staticmethod
    def _srt(cues):
        seen, uniq = set(), []
        for c in sorted(cues, key=lambda x: (x[0], x[1])):
            k = (round(c[0], 2), round(c[1], 2), c[2])
            if k not in seen:
                seen.add(k)
                uniq.append(c)

        def ts(t):
            ms = int(round(t * 1000))
            h, ms = divmod(ms, 3600000)
            m, ms = divmod(ms, 60000)
            s, ms = divmod(ms, 1000)
            return "%02d:%02d:%02d,%03d" % (h, m, s, ms)

        return "\n".join("%d\n%s --> %s\n%s\n" % (i, ts(a), ts(b), txt)
                         for i, (a, b, txt) in enumerate(uniq, 1))

    def _subtitle_cues(self, url, track):
        """Fetch and merge an HLS subtitle track's WebVTT segments into cues."""
        key = url.split("?")[0] + "|" + track
        with self.cache_lock:
            self._expire_if_due()
            if key in self.sub_cache:
                return self.sub_cache[key]
        subs = self._subs_from_master(self._get(url))
        if not subs:
            return []
        chosen = next((s for s in subs if track in ("", s["name"], s["lang"])), subs[0])
        base = url.rsplit("/", 1)[0] + "/"
        pl_url = urllib.parse.urljoin(base, chosen["uri"])
        seg_base = pl_url.rsplit("/", 1)[0] + "/"
        segs = [urllib.parse.urljoin(seg_base, l) for l in self._get(pl_url).splitlines()
                if l and not l.startswith("#")]

        def grab(u):
            try:
                return self._parse_vtt(self._get(u))
            except Exception:
                return []
        cues = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
            for part in ex.map(grab, segs):
                cues.extend(part)
        with self.cache_lock:
            remember(self.sub_cache, key, cues, SUB_CACHE_MAX)
        return cues

    def vod_subtitle_srt(self, url, track="", shift=0.0):
        """Merged SRT for a subtitle track, optionally time-shifted by `shift` seconds."""
        cues = self._subtitle_cues(url, track)
        if shift:
            cues = [(max(0.0, a + shift), max(0.0, b + shift), t) for (a, b, t) in cues]
        return self._srt(cues)

    # -- Live --------------------------------------------------------------
    def live_genres(self, group=None):
        js = self.call({"type": "itv", "action": "get_genres"}, ttl=3600)
        lock = self.lock_active()
        genres = [{"id": str(g["id"]), "title": g["title"]} for g in js or []
                  if not (lock and ADULT_TITLE.search(g.get("title") or ""))]
        top, subs = group_live(genres)
        if group is None:
            row = self.adult_row()
            return top + [row] if row else top
        return [{"id": "back", "title": "< All groups", "back": True}] + subs.get(group, [])

    def live_channels(self, genre, page):
        js = self.call({"type": "itv", "action": "get_ordered_list",
                        "genre": genre or "*", "p": page, "sortby": "number",
                        "fav": 0}, ttl=600)
        return self._page(js, lambda x: {
            "id": str(x.get("id")), "number": x.get("number") or "",
            "name": x.get("name") or "", "logo": self.abs_url(x.get("logo")),
            "cmd": x.get("cmd") or "",
        })

    def live_link(self, cmd):
        js = self.call({"type": "itv", "action": "create_link", "cmd": cmd,
                        "forced_storage": "undefined", "disable_ad": 0})
        raw = (js or {}).get("cmd") or ""
        return {"url": self.clean_cmd(raw), "cmd": raw}


def mock_art(seed, title, logo=False):
    """SVG stand-in for a poster or a channel logo. Mock mode only."""
    h = int(hashlib.md5(seed.encode()).hexdigest()[:8], 16)
    hue, hue2 = h % 360, (h % 360 + 40 + (h >> 9) % 80) % 360
    if logo:
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="152" height="100" viewBox="0 0 152 100">'
                '<rect width="152" height="100" rx="12" fill="hsl(%d,55%%,38%%)"/>'
                '<text x="76" y="62" font-family="Arial" font-size="34" font-weight="bold" fill="#fff" '
                'text-anchor="middle">%s</text></svg>' % (hue, html.escape(title[:3].upper())))
    words, lines = title.split(), [""]
    for w in words:                                   # wrap the title to ~11 characters a line
        if lines[-1] and len(lines[-1]) + len(w) > 10:
            lines.append("")
        lines[-1] = (lines[-1] + " " + w).strip()
    text = "".join('<text x="24" y="%d" font-family="Arial" font-size="34" font-weight="bold" fill="#fff">%s</text>'
                   % (300 + i * 40, html.escape(l)) for i, l in enumerate(lines[:3]))
    cx, cy, r = 60 + (h >> 4) % 180, 90 + (h >> 12) % 120, 60 + (h >> 20) % 70
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450" '
            'preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="hsl(%d,60%%,42%%)"/><stop offset="1" stop-color="hsl(%d,65%%,14%%)"/>'
            '</linearGradient></defs><rect width="300" height="450" fill="url(#g)"/>'
            '<circle cx="%d" cy="%d" r="%d" fill="hsl(%d,80%%,62%%)" opacity=".55"/>'
            '<circle cx="%d" cy="%d" r="%d" fill="hsl(%d,70%%,30%%)" opacity=".6"/>'
            '<rect y="250" width="300" height="200" fill="#000" opacity=".28"/>%s</svg>'
            % (hue, hue2, cx, cy, r, hue2, 300 - cx // 2, cy + 130, r + 30, hue, text))


class Mock:
    """Fake backend for trying the UI in a desktop browser."""

    SAMPLE = "https://media.w3.org/2010/05/sintel/trailer.mp4"
    PIN = "0000"
    CATS = ["New Movies", "Action", "Comedy", "Drama", "Kids", "TV Series", "Documentary", "4K UHD"]
    FIRST = ["The Last", "Midnight", "Silent", "Crimson", "Paper", "Electric", "Hollow", "Golden",
             "Broken", "Wild", "Northern", "Savage", "Quiet", "Burning", "Lost", "Iron"]
    SECOND = ["Harbor", "Run", "Empire", "Garden", "Protocol", "Highway", "Kingdom", "Witness", "Orchard",
              "Frontier", "Tide", "Letters", "Signal", "Summer", "Avenue", "Machine", "River"]
    PLOT = ("A stranger arrives in a town that has kept one secret for thirty years. "
            "What begins as a favour for an old friend becomes a race against the people who buried it. ")

    def __init__(self):
        self.adult_unlocked = False

    def vod_categories(self):
        rows = [{"id": str(i), "title": t} for i, t in enumerate(self.CATS, 1)]
        out = [{"header": "★ MY PICKS"}] + rows[:4] + [{"header": "MORE"}] + rows[4:]
        if self.adult_unlocked:
            return out + [{"id": "9", "title": "Adult"},
                          {"id": "adult-lock", "title": "Lock adult content", "adult": "lock"}]
        return out + [{"id": "adult-unlock", "title": "Adult content (PIN)", "adult": "unlock"}]

    def adult_unlock(self, pin):
        if str(pin) != self.PIN:
            raise RuntimeError("wrong PIN")
        self.adult_unlocked = True
        return {"ok": True}

    def adult_lock(self):
        self.adult_unlocked = False
        return {"ok": True}

    def _movie(self, cat, i):
        c = int(cat)
        series = cat == "6" or i % 11 == 7
        name = "%s %s" % (self.FIRST[(i * 3 + c) % 16], self.SECOND[(i * 5 + c * 2) % 17])
        predvd = i % 9 == 4 and not series
        return {"id": "%s%03d" % (cat, i), "category_id": cat, "name": name + (" (PREDVD)" if predvd else ""),
                "warn": "PREDVD" if predvd else "", "adult": cat == "9",
                "year": str(2002 + (i * 7 + c) % 24), "rating": "" if i % 6 == 5 else "%.1f" % (5 + (i * 7) % 45 / 10.0),
                "genres": ["Action, Thriller", "Drama", "Comedy, Romance", "Sci-Fi, Adventure"][(i + c) % 4],
                "director": "J. Doe", "actors": "A. Actor, B. Actor, C. Actor",
                "time": str(88 + (i * 13) % 70), "description": self.PLOT * (1 + i % 3),
                "poster": "" if i % 13 == 12 else "/mock/art/%s%03d.svg?t=%s" % (cat, i, urllib.parse.quote(name)),
                "cmd": "mock", "is_series": series, "is_season": False,
                "is_episode": False, "series": []}

    def vod_list(self, category, page, search=""):
        cats = [category] if category not in ("*", "") else [str(c) for c in range(1, 9)]
        items = [self._movie(c, i) for c in cats for i in range(61)]
        if search:
            items = [m for m in items if search.lower() in m["name"].lower()]
        start = (page - 1) * 14
        return {"total": len(items), "per_page": 14, "items": items[start:start + 14]}

    def vod_children(self, movie_id, season_id="0", episode_id="0"):
        if season_id == "0":
            items = [{"id": "s%d" % s, "name": "Season %d" % s, "is_season": True} for s in (2, 1, 3)]
        else:
            items = [{"id": "%se%d" % (season_id, e), "name": "Episode %d" % e, "is_episode": True,
                      "series_number": str(e)} for e in range(8, 0, -1)]
        return {"total": len(items), "per_page": len(items), "items": items}

    def vod_play(self, movie_id, season_id="0", episode_id="0", series=""):
        return {"url": self.SAMPLE}

    def vod_release(self, url):
        return {"ok": True}

    def vod_subs(self, url):
        return [{"name": "English", "lang": "eng"}]

    def vod_subtitle_srt(self, url, track="", shift=0.0):
        return "1\n00:00:01,000 --> 00:00:04,000\nSample subtitle (mock)\n"

    def live_genres(self, group=None):
        titles = ["ENGLISH | News", "ENGLISH | Sports", "ENGLISH | Movies", "HINDI | News",
                  "HINDI | Entertainment", "KIDS"]
        genres = [{"id": "*", "title": "All"}] + [{"id": str(i), "title": t} for i, t in enumerate(titles, 1)]
        top, subs = group_live(genres)
        if group is None:
            return top
        return [{"id": "back", "title": "< All groups", "back": True}] + subs.get(group, [])

    def live_channels(self, genre, page):
        names = ["News 24", "Sports One", "Cinema Max", "Kids Planet", "Music Box", "Nature HD", "City TV"]
        start = (page - 1) * 14
        items = [{"id": str(i), "number": str(i), "name": "%s %d" % (names[i % 7], i),
                  "logo": "" if i % 5 == 0 else "/mock/art/ch%d.svg?logo=1&t=%s" % (i, urllib.parse.quote(names[i % 7])),
                  "cmd": "mock"} for i in range(start + 1, min(start + 15, 41))]
        return {"total": 40, "per_page": 14, "items": items}

    def live_link(self, cmd):
        return {"url": self.SAMPLE}

    def clear_cache(self):
        return {"ok": True}


def make_handler(backend, cfg):
    routes = {
        "/api/state": lambda q: read_state(),
        "/api/vod/categories": lambda q: backend.vod_categories(),
        "/api/vod/list": lambda q: backend.vod_list(q.get("category", "*"), int(q.get("page", 1)), q.get("search", "")),
        "/api/vod/children": lambda q: backend.vod_children(q["movie_id"], q.get("season_id", "0"), q.get("episode_id", "0")),
        "/api/vod/play": lambda q: backend.vod_play(q["movie_id"], q.get("season_id", "0"), q.get("episode_id", "0"), q.get("series", "")),
        "/api/vod/release": lambda q: backend.vod_release(q["url"]),
        "/api/adult/unlock": lambda q: backend.adult_unlock(q.get("pin", "")),
        "/api/adult/lock": lambda q: backend.adult_lock(),
        "/api/cache/clear": lambda q: backend.clear_cache(),
        "/api/vod/subs": lambda q: backend.vod_subs(q["url"]),
        "/api/live/genres": lambda q: backend.live_genres(q.get("group")),
        "/api/live/channels": lambda q: backend.live_channels(q.get("genre", "*"), int(q.get("page", 1))),
        "/api/live/link": lambda q: backend.live_link(q["cmd"]),
    }

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=WEB, **kw)

        def do_POST(self):
            if self.path.startswith("/stalker_portal/"):
                return self.proxy()
            if self.path == "/api/state":
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    update = json.loads(self.rfile.read(length) or b"{}")
                    with STATE_LOCK:
                        state = read_state()
                        state.update(update)
                        tmp = STATE_FILE + ".tmp"
                        with open(tmp, "w") as f:
                            json.dump(state, f)
                        os.replace(tmp, STATE_FILE)
                except ValueError:
                    return self.send_error(400)
                self.send_response(204)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/stalker_portal/"):
                return self.proxy()
            if parsed.path in ("/api/vod/subtitle", "/api/vod/subtitle.srt"):   # raw SRT for the player to load
                q = dict(urllib.parse.parse_qsl(parsed.query))
                try:
                    shift = float(q.get("shift", 0) or 0)
                    srt = backend.vod_subtitle_srt(q.get("url", ""), q.get("track", ""), shift).encode("utf-8")
                except Exception as e:
                    self.log_error("subtitle %s -> %s", self.path, e)
                    return self.send_error(502, str(e))
                self.send_response(200 if srt else 404)
                self.send_header("Content-Type", "application/x-subrip; charset=utf-8")
                self.send_header("Content-Length", str(len(srt)))
                self.end_headers()
                self.wfile.write(srt)
                return
            if cfg["mock"] and parsed.path.startswith("/mock/art/"):          # generated posters and logos
                q = dict(urllib.parse.parse_qsl(parsed.query))
                art = mock_art(parsed.path, q.get("t", ""), bool(q.get("logo"))).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml")
                self.send_header("Content-Length", str(len(art)))
                self.end_headers()
                self.wfile.write(art)
                return
            # clean URLs: /settings -> web/settings.html
            last = parsed.path.rsplit("/", 1)[-1]
            if last and "." not in last and os.path.isfile(os.path.join(WEB, parsed.path.lstrip("/") + ".html")):
                self.path = parsed.path + ".html" + ("?" + parsed.query if parsed.query else "")
            route = routes.get(parsed.path)
            if not route:
                return super().do_GET()
            q = dict(urllib.parse.parse_qsl(parsed.query))
            if cfg["mock"] and MOCK_DELAY:                        # MOCK_DELAY=0.8: see the loading states
                time.sleep(MOCK_DELAY)
            try:
                body, status = json.dumps(route(q)).encode(), 200
            except Exception as e:  # report backend errors to the UI
                body, status = json.dumps({"error": str(e)}).encode(), 502
                self.log_error("%s -> %s", self.path, e)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            if not self.path.startswith(("/api/", "/stalker_portal/")):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def proxy(self):
            """Pass /stalker_portal/* through to the provider unchanged.

            Lets the box run the provider's own portal via this server so we can
            record the device parameters it sends when logging in."""
            upstream = cfg["portal"].rstrip("/") + self.path
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else None
            skip = {"host", "accept-encoding", "connection", "content-length"}
            headers = {k: v for k, v in self.headers.items() if k.lower() not in skip}
            if "load.php" in self.path or "portal.php" in self.path:
                capture("%s %s\n  cookie=%s\n  ua=%s\n  x-ua=%s\n  auth=%s" % (
                    self.command, urllib.parse.unquote(self.path), headers.get("Cookie"),
                    headers.get("User-Agent"), headers.get("X-User-Agent"),
                    headers.get("Authorization")))
            req = urllib.request.Request(upstream, data=data, headers=headers, method=self.command)
            try:
                resp = NO_REDIRECT.open(req, timeout=30)
            except urllib.error.HTTPError as e:
                resp = e
            except Exception as e:
                return self.send_error(502, str(e))
            body = resp.read()
            self.send_response(resp.status if hasattr(resp, "status") else resp.code)
            for k, v in resp.headers.items():
                if k.lower() in ("transfer-encoding", "connection", "content-length"):
                    continue
                if k.lower() == "location":
                    v = v.replace(cfg["portal"].rstrip("/"), "")
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            super().end_headers()
            self.wfile.write(body)

    return Handler


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


NO_REDIRECT = urllib.request.build_opener(_NoRedirect)
MOCK_DELAY = float(os.environ.get("MOCK_DELAY") or 0)   # seconds added to every mock API reply
CAPTURE_LOG = os.path.join(ROOT, "capture.log")
STATE_FILE = os.path.join(ROOT, "state.json")
STATE_LOCK = threading.Lock()


def read_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def capture(line):
    with open(CAPTURE_LOG, "a") as f:
        f.write(time.strftime("%H:%M:%S ") + line + "\n")


def main():
    cfg = load_config()
    if cfg["mock"]:
        backend = Mock()
    else:
        if not re.match(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$", cfg["mac"]):
            sys.exit("Set your MAG's MAC (e.g. 00:1A:79:XX:XX:XX) in config.json "
                     "or the MAC env var. Use MOCK=1 to try the UI without it.")
        backend = Stalker(cfg)
    server = ThreadingHTTPServer(("0.0.0.0", cfg["port"]), make_handler(backend, cfg))
    print("IP TV portal on http://0.0.0.0:%d/ (%s)" % (
        cfg["port"], "mock data" if cfg["mock"] else cfg["portal"]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
