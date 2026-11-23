# fresh4k on LG webOS TV (spike)

Standalone TV app: the UI and the Stalker proxy both run on the TV.

## Layout
- `app/` — source of the webOS app (committed).
  - `appinfo.json`, `index.html` — the page.
  - `service/` — Node service that talks to the portal.
- `build.py` — stages `app/` into `build/`, adds `config.json`, writes an icon.
- `build/` — generated, contains device IDs. Gitignored. Never commit.

## Build and install (from this PC)
```
python3 tv/build.py
cd tv
ares-package build
ares-install --device tv com.fresh4k.app_0.1.0_all.ipk
ares-launch --device tv com.fresh4k.app
```
Logs: `ares-inspect --device tv --app com.fresh4k.app --open` or `ares-log --device tv`.
