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
    "image_version": "220",
    "image_desc": "2.20.12-544",
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
        self.cache = {}

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
        """Handshake + get_profile, mirroring what the MAG's own portal sends."""
        self.token = None
        js = self._request({"type": "stb", "action": "handshake", "token": "", "prehash": "false"})
        self.token = js["token"]
        c = self.cfg
        metrics = json.dumps({"mac": c["mac"], "sn": c["sn"], "model": c["model"], "type": "STB",
                              "uid": c["device_id2"], "random": js.get("random", "")},
                             separators=(",", ":"))
        profile = self._request({
            "type": "stb", "action": "get_profile", "hd": 1,
            "ver": "ImageDescription: %s; PORTAL version: 5.6.10; API Version: JS API version: 349"
                   % c["image_desc"],
            "num_banks": 1, "sn": c["sn"], "stb_type": c["model"], "client_type": "STB",
            "image_version": c["image_version"], "video_out": "hdmi",
            "device_id": c["device_id"], "device_id2": c["device_id2"],
            "signature": c["signature"], "auth_second_step": 0,
            "hw_version": c["hw_version"], "not_valid_token": 0, "metrics": metrics,
            "hw_version_2": c["hw_version_2"], "timestamp": int(time.time()),
            "api_signature": 241, "prehash": "false",
        })
        status = str((profile or {}).get("status", "0"))
        if status != "0":
            raise RuntimeError("portal login refused (status %s): %s" % (status, profile.get("msg", "")))

    def call(self, params, ttl=0):
        key = tuple(sorted(params.items()))
        if ttl:
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
            self.cache[key] = (time.time() + ttl, result)
        return result

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

    # -- VOD ---------------------------------------------------------------
    def vod_categories(self):
        js = self.call({"type": "vod", "action": "get_categories"}, ttl=3600)
        cats = [{"id": str(c["id"]), "title": c["title"]} for c in js or []
                if str(c.get("id")) != "*"]
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

    def vod_list(self, category, page, search=""):
        # category "*" searches everything; a real id scopes the search to it.
        p = {"type": "vod", "action": "get_ordered_list", "category": category or "*",
             "genre": "*", "p": page, "sortby": "added", "fav": 0}
        if search:
            p["search"] = search
        return self._page(self.call(p, ttl=600), self._vod_item)

    def vod_children(self, movie_id, season_id="0", episode_id="0"):
        """Drill into a title: seasons (season_id=0), episodes of a season, or
        the playable files of a movie/episode. Returns every page."""
        items, page, total = [], 1, 1
        while len(items) < total and page <= 20:
            js = self.call({"type": "vod", "action": "get_ordered_list", "category": "*",
                            "movie_id": movie_id, "season_id": season_id,
                            "episode_id": episode_id, "fav": 0, "sortby": "added",
                            "hd": 0, "not_ended": 0, "p": page}, ttl=600)
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

    # -- Live --------------------------------------------------------------
    def live_genres(self):
        js = self.call({"type": "itv", "action": "get_genres"}, ttl=3600)
        return [{"id": str(g["id"]), "title": g["title"]} for g in js or []]

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


class Mock:
    """Fake backend for trying the UI in a desktop browser."""

    SAMPLE = "https://media.w3.org/2010/05/sintel/trailer.mp4"

    def vod_categories(self):
        return [{"id": str(i), "title": t} for i, t in enumerate(
            ["New Movies", "Action", "Comedy", "Drama", "Kids", "TV Series",
             "Documentary", "4K UHD"], 1)]

    def _movie(self, cat, i):
        series = cat == "6"
        return {"id": "%s%03d" % (cat, i), "name": ("Series" if series else "Movie") + " %s-%d" % (cat, i),
                "year": str(2000 + i % 25), "rating": "%.1f" % (5 + (i * 7) % 50 / 10.0),
                "genres": "Action, Drama", "director": "J. Doe", "actors": "A. Actor, B. Actor",
                "time": "112", "description": "A short synopsis of the title goes here. " * 3,
                "poster": "", "cmd": "mock", "is_series": series, "is_season": False,
                "is_episode": False, "series": []}

    def vod_list(self, category, page, search=""):
        cat = category if category not in ("*", "") else "1"
        start = (page - 1) * 14
        items = [self._movie(cat, i) for i in range(start, min(start + 14, 61))]
        if search:
            items = [m for m in items if search.lower() in m["name"].lower()]
        return {"total": 61, "per_page": 14, "items": items}

    def vod_children(self, movie_id, season_id="0", episode_id="0"):
        if season_id == "0":
            items = [{"id": "s%d" % s, "name": "Season %d" % s, "is_season": True} for s in range(1, 4)]
        else:
            items = [{"id": "e%d" % e, "name": "Episode %d" % e, "is_episode": True,
                      "series_number": str(e)} for e in range(10, 0, -1)]
        return {"total": len(items), "per_page": len(items), "items": items}

    def vod_play(self, movie_id, season_id="0", episode_id="0", series=""):
        return {"url": self.SAMPLE}

    def vod_release(self, url):
        return {"ok": True}

    def live_genres(self):
        return [{"id": "1", "title": "News"}, {"id": "2", "title": "Sports"}]

    def live_channels(self, genre, page):
        return {"total": 20, "per_page": 20, "items": [
            {"id": str(i), "number": str(i), "name": "Channel %d" % i, "logo": "", "cmd": "mock"}
            for i in range(1, 21)]}

    def live_link(self, cmd):
        return {"url": self.SAMPLE}


def make_handler(backend, cfg):
    routes = {
        "/api/state": lambda q: read_state(),
        "/api/vod/categories": lambda q: backend.vod_categories(),
        "/api/vod/list": lambda q: backend.vod_list(q.get("category", "*"), int(q.get("page", 1)), q.get("search", "")),
        "/api/vod/children": lambda q: backend.vod_children(q["movie_id"], q.get("season_id", "0"), q.get("episode_id", "0")),
        "/api/vod/play": lambda q: backend.vod_play(q["movie_id"], q.get("season_id", "0"), q.get("episode_id", "0"), q.get("series", "")),
        "/api/vod/release": lambda q: backend.vod_release(q["url"]),
        "/api/live/genres": lambda q: backend.live_genres(),
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
            # clean URLs: /settings -> web/settings.html
            last = parsed.path.rsplit("/", 1)[-1]
            if last and "." not in last and os.path.isfile(os.path.join(WEB, parsed.path.lstrip("/") + ".html")):
                self.path = parsed.path + ".html" + ("?" + parsed.query if parsed.query else "")
            route = routes.get(parsed.path)
            if not route:
                return super().do_GET()
            q = dict(urllib.parse.parse_qsl(parsed.query))
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
    print("fresh4k portal on http://0.0.0.0:%d/ (%s)" % (
        cfg["port"], "mock data" if cfg["mock"] else cfg["portal"]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
