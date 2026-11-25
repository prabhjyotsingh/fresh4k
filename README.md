# fresh4k

A small, remote-friendly portal UI for a MAG set-top box, backed by a
provider's Stalker/Ministra API (MAC-based auth). The box loads the UI from
this server; the server fetches channels, VOD and stream links from the
provider on the box's behalf.

Built for the **MAG544w3** (1280×720, old WebKit). The UI is plain ES5 with no
build step; the server is Python 3.7+ with no dependencies.

## Layout

```
server.py      # HTTP server: serves web/, exposes /api/*, logs in to the provider
web/           # the UI (index.html, app.css, app.js) — vanilla JS, no framework
tv/            # LG webOS TV build (standalone app); see tv/README.md
config.json    # your box's MAC + device IDs (not committed; see config.example.json)
```

## Prerequisites

For the MAG server: Python 3.7+. Nothing to install beyond that.

For the LG TV app, the build machine also needs Python 3.7+, Node.js 18+ with
npm, and the webOS CLI (`@webos-tools/cli` 3.2.6). The full list, plus how to
turn on Developer Mode on the TV and register it with the build machine, is in
[tv/README.md](tv/README.md).

## Setup

1. Copy the example config and fill in your box's details:

   ```
   cp config.example.json config.json
   ```

   - `mac` — the box's device MAC (MAG: `00:1A:79:…`, from Settings → Device info).
     Use the box's `00:1A:79:…` MAC, not the Wi-Fi adapter's own MAC, which the
     portal rejects.
   - `device_id`, `device_id2` — **required**. The portal refuses the login
     without them. Get them from a capture, below.
   - `sn`, `hw_version`, `hw_version_2`, `signature` — **optional**, not in the
     example config. Tested: the portal accepts a login without them. The server
     sends them only if you add them to `config.json`.

   **Getting the login values (capture)**

   1. Start the server, then point the box's Portal 1 at
      `http://<this-host>:<port>/stalker_portal/c/` and reboot the box.
   2. The server proxies the real portal and writes every request to
      `capture.log`, including the full query string. Find the login request:

      ```
      grep 'action=get_profile' capture.log | tail -1
      ```

   3. Copy the values for `device_id` and `device_id2` (the `device_id=` and
      `device_id2=` parameters) from that line into `config.json`.
   4. Set Portal 1 back to this server, and keep `capture.log` out of git (it is
      already in `.gitignore`).

   Don't paste these values into the README, a commit, or a chat. They identify your box.
   - `timezone` — e.g. `America/Toronto`.
   - `vod_categories` (optional) — a flat list of category IDs to show in the
     Movies & Series menu, in order. Empty/omitted shows every category.
   - `vod_groups` (optional) — organise the menu under section headers, e.g.
     `[{"title": "HINDI", "ids": ["19", "15"]}, ...]`. Takes precedence over
     `vod_categories`. Headers are shown as non-selectable dividers.

2. Run it:

   ```
   python3 server.py            # uses config.json
   MOCK=1 python3 server.py     # fake data, to try the UI in a desktop browser
   ```

3. On the MAG, set **Settings → Servers → Portals → Portal 1** to
   `http://<this-host>:<port>/` (e.g. `http://10.0.0.7:8080/`). Keep
   `http://fresh4k.cc` as Portal 2 to fall back to the provider's own portal.

Run only one portal at a time: the provider allows a single login per device,
so the stock portal and this server will log each other out if used together.

## Remote keys (MAG544w3)

| Button | Action |
|--------|--------|
| Arrows / OK | Navigate / open / play |
| Back | Up one level; during playback, stop |
| CH+ / CH− | Page through long lists |
| Blue | Add/remove the selected title in My List |
| Red | Reload the portal |
| Play, ◄ ►, ▲ ▼, Rew/Fwd, Info | Pause, seek, skip, toggle the progress bar |

## State

Favorites and resume positions are stored server-side in `state.json`, so they
survive box reboots and firmware resets.

## Status

- Movies & series: browse, play, resume — working on-device.
- Live TV and Search: implemented, not yet verified on-device.
