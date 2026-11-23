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
config.json    # your box's MAC + device IDs (not committed; see config.example.json)
```

## Setup

1. Copy the example config and fill in your box's details:

   ```
   cp config.example.json config.json
   ```

   - `mac` — the box's device MAC (MAG: `00:1A:79:…`, from Settings → Device info).
   - `device_id` / `device_id2` — the UID values the box sends at login. If the
     provider rejects a MAC-only login, point the box's portal at
     `http://<this-host>:<port>/stalker_portal/c/` once; the server proxies the
     real portal and records the exact login parameters to `capture.log`.
   - `timezone` — e.g. `America/Toronto`.

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
