# IP TV on LG webOS

A standalone TV app: the UI and the portal client (`service/`) both run on the
TV. Nothing else has to stay on, apart from the TV itself.

Tested on an LG 55UQ7570PUJ (webOS 22, SDK 7.6.0, service runtime Node 12.21.0).

## Layout

- `app/`: source of the webOS app (committed).
  - `appinfo.json`, `index.html`, `app.css`, `transport.js`: the TV build's
    page setup. `icon.png` and `largeIcon.png` are the logo.
  - `service/`: Node service that talks to the portal. Its `package.json`
    pins Node 12.21.0, because that is the version the TV runs.
- `build.py`: stages `web/` and `app/` into `build/`, copies in your
  `config.json` and LG's `webOSTV.js`.
- `build/`: generated. Contains your device IDs and the MAC, so it is
  gitignored. Never commit it, and don't share the `.ipk`, which contains it too.
- `package.json`: npm scripts for the build (below).

## Build machine prerequisites

Needed on the computer you build and install from (not on the TV):

| Requirement | Why | Check |
|---|---|---|
| Python 3.7+ | runs `build.py` (standard library only) | `python3 --version` |
| Node.js 18+ and npm | runs the webOS CLI | `node -v`, `npm -v` |
| `@webos-tools/cli` 3.2.6 | provides `ares-package`, `ares-install`, `ares-setup-device`, `ares-novacom`, `ares-device` | `ares-device --help` |
| The TV and this PC on the same network | install and debugging go over SSH | `ping <TV_IP>` |
| `config.json` in the repo root | device IDs for the portal login | `ls ../config.json` |

Install the CLI once, globally, so the `ares-*` commands are on your PATH:

```
sudo npm install -g @webos-tools/cli@3.2.6
```

Don't use `@webosose/ares-cli`. Its latest release (2.4.0) has no
`ares-novacom --getkey`, which the setup below needs.

## Enable Developer Mode on the TV

Do this once. The developer session expires about every 50 hours, so repeat
the "turn on" steps when the app stops installing or connecting.

1. On the TV, press **Home** and open **LG Content Store**.
2. Search for **Developer Mode**, then install the app published by LG.
3. Create a free developer account at the webOS TV developer site, if you
   don't already have one.
4. Open **Developer Mode** on the TV and sign in with that account.
5. Turn **Dev Mode status** **ON**.
6. Turn **Key Server** **ON**. The key step below fails without it.
7. Note the **IP address** shown (wireless) and the **Passphrase**. The
   passphrase changes each time Dev Mode is turned on.

## Register the TV with this machine

Replace `TV_IP` with the wireless IP from step 7, and enter the passphrase when
asked. Don't put the passphrase in a file or in the repo.

1. Add the TV as a device:

   ```
   ares-setup-device --add tv --info "{\"host\":\"TV_IP\",\"port\":\"9922\",\"username\":\"prisoner\"}"
   ```

2. Download the SSH key for the TV. It is saved to `~/.ssh/tv_webos`:

   ```
   ares-novacom --device tv --getkey
   ```

   If this fails with `Failed to get ssh private key`, Key Server is off, or
   the passphrase is out of date. Check step 6 and retry.

3. Check that the connection works. It should print the model and firmware:

   ```
   ares-device -d tv -i
   ```

If step 3 says `connect ECONNREFUSED`, Dev Mode is off or has expired. If it
says `All configured authentication methods failed`, run step 2 again.

## Build and install

From the `tv/` folder, with the TV registered as `tv`:

```
npm install            # once: installs @webos-tools/cli locally
npm run package        # stages build/ and creates com.fresh4k.app_0.1.0_all.ipk here
npm run install-tv     # packages, installs, and launches the app on the TV
```

Or without npm, using the global CLI:

```
python3 build.py                        # run from tv/
ares-package -o . build
ares-install --device tv com.fresh4k.app_0.1.0_all.ipk
ares-launch --device tv com.fresh4k.app
```

Rebuild after any change to `config.json`, `web/`, or `app/`. The TV runs the
copy from the last install.

## Logs and debugging

- Page console (DevTools): `ares-inspect --device tv --app com.fresh4k.app --open`
- Service log: `ares-log --device tv`
