# fresh4k

A small, remote-friendly portal UI for a MAG set-top box, backed by a
provider's Stalker/Ministra API (MAC-based auth). The box loads the UI from
this server; the server fetches channels, VOD and stream links from the
provider on the box's behalf.

It has two front ends on the same code: the **MAG544w3** set-top box (1280×720,
old WebKit) and an **LG webOS TV** app, which runs the UI and a small Node
service on the TV itself. The UI is plain ES5 with no build step; the server is
Python 3.7+ with no dependencies.

What it offers: movies and series (browse by category, search, seasons and
episodes, resume), live TV by genre, subtitles with a timing adjustment, and
server-side My List, Continue watching and watched-episode tracking. Adult
categories sit behind a PIN.

## Layout

```
server.py          # HTTP server: serves web/, exposes /api/*, logs in to the provider
web/               # the UI (index.html, app.css, app.js) — vanilla JS, no framework
web/subtest.html   # subtitle-timing probe page for on-device testing (not linked from the UI)
tv/                # LG webOS TV build (standalone app); see tv/README.md
tv/build.py        # stages web/ and tv/app/ into tv/build/ for packaging
tv/app/            # webOS app: appinfo, transport.js, and tv/app/service (Node)
config.example.json  # template for config.json
config.json        # your box's MAC + device IDs (not committed; see Setup)
state.json         # My List, resume points, watched episodes (created at runtime, not committed)
capture.log        # recorded portal requests, if you capture (not committed)
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

   Mock mode needs no `config.json`. It draws its own posters, has an adult
   row with the PIN `0000`, and `MOCK_DELAY=0.8` (seconds) slows every reply
   down so the loading states can be seen.

3. On the MAG, set **Settings → Servers → Portals → Portal 1** to
   `http://<this-host>:<port>/` (e.g. `http://10.0.0.7:8080/`). Keep
   `http://fresh4k.cc` as Portal 2 to fall back to the provider's own portal.

Run only one portal at a time: the provider allows a single login per device,
so the stock portal and this server will log each other out if used together.

## Screens

- **Home** opens first. A row of **Continue watching**, a row of **My List**,
  then one row for each category in the first section of the Movies & Series
  menu (the first `vod_groups` entry; without groups, the first eight
  categories). The top of the screen describes the title under the cursor.
- **Movies & Series**, **Live TV**: categories on the left, the list on the
  right. Coming back to a category puts the cursor where it was.
- **Search**: results appear as you type. Earlier searches are listed on the left.
- **My List**: the titles you saved, and everything in Continue watching.
- **A title's page**: play or resume, seasons and episodes (watched episodes
  are marked; the cursor starts on the next one), My List.
- **Playback**: when an episode ends, the next one starts after a 10-second
  countdown, into the next season too. A series stays in Continue watching,
  pointing at the next episode.

## Remote keys (MAG544w3)

| Button | Action |
|--------|--------|
| Arrows / OK | Navigate / open. In Home's Continue watching row, OK resumes at once |
| Back | Up one level; during playback, stop |
| CH+ / CH− | Page through long lists |
| Play | On a title: play it now, from where you left it |
| Info | On Home: open the title's page. During playback: show or hide the progress bar |
| Blue | Add/remove the selected title in My List |
| Yellow | Remove the selected title from Continue watching |
| Green | During playback: audio & subtitles |
| Red | Reload the portal |

During playback: OK or Play pauses, ◄ ► skip 30 s, Rew/Fwd 2 minutes, ▲ ▼
5 minutes. Holding a key speeds the skip up (double after 6 steps, four times
after 12). The line at the bottom of each screen lists the keys that apply there.

In the audio & subtitles menu, the **Delay** row shifts subtitle timing: ◄ ►
moves it 0.25 s, CH+ / CH− 30 s.

## State

My List, resume positions, watched episodes and recent searches are stored
server-side in `state.json`, so they survive box reboots and firmware resets.
A title enters Continue watching after 30 seconds of playback and leaves it
when watched past 95%.

## Status

- Movies & series: browse, play, resume work on-device.
- The screens described above were rebuilt after that and have been checked in
  desktop Chrome only: with mock data, with a stand-in for the MAG's player, and
  through the TV transport. They have not been run on the MAG or the TV yet.
- Subtitles: the provider's subtitle track is converted to SRT and loaded by the
  player. Timing can be adjusted from the audio & subtitles menu. Not yet
  confirmed on-device; `web/subtest.html` is a probe page for checking it.
- Live TV and Search: implemented, not yet verified on-device.
- The LG TV build runs the same screens through `tv/app/transport.js`. The
  portal client runs on the TV in `tv/app/service/`. See [tv/README.md](tv/README.md).
