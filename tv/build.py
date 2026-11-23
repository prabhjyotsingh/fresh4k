#!/usr/bin/env python3
"""Stage the webOS app for packaging.

Copies tv/app into tv/build/, adds the device config from the repo's
config.json (gitignored), and writes a placeholder icon. Run from anywhere:

    python3 tv/build.py

Then package with ares-package (see tv/README.md). The staged folder holds
your device IDs, so tv/build/ is gitignored and must never be committed.
"""
import json
import os
import shutil
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(HERE, "app")
OUT = os.path.join(HERE, "build")

# Same defaults as server.py; config.json overrides them.
DEFAULTS = {
    "portal": "http://fresh4k.cc",
    "api_path": "/stalker_portal/server/load.php",
    "mac": "", "timezone": "Europe/London", "model": "MAG544", "link": "WiFi",
    "sn": "", "device_id": "", "device_id2": "", "signature": "",
    "hw_version": "", "hw_version_2": "", "image_version": "220",
    "image_desc": "2.20.12-544",
    "user_agent": ("Mozilla/5.0 (Unknown; Linux) AppleWebKit/538.1 (KHTML, like Gecko) "
                   "MAG200 stbapp ver: 4 rev: 734 Mobile Safari/538.1"),
}


def png(width, height, rgb):
    """Write a solid-colour PNG without any third-party library."""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) +
            chunk(b"IEND", b""))


def find_webos_lib():
    """Locate LG's webOSTV.js, which ships inside the webOS CLI template.

    Not committed to the repo: it is copied from the installed CLI at build time.
    """
    import glob
    patterns = [
        "/usr/local/lib/node_modules/@webos-tools/cli",
        "/usr/lib/node_modules/@webos-tools/cli",
        os.path.expanduser("~/.nvm/versions/node/*/lib/node_modules/@webos-tools/cli"),
    ]
    for base in patterns:
        hits = glob.glob(os.path.join(base, "files", "templates", "**", "webOSTVjs-*", "webOSTV.js"),
                         recursive=True)
        if hits:
            return hits[0]
    sys.exit("webOSTV.js not found. Install the CLI: sudo npm install -g @webos-tools/cli")


def main():
    cfg_path = os.path.join(ROOT, "config.json")
    if not os.path.exists(cfg_path):
        sys.exit("config.json not found in the repo root")
    with open(cfg_path) as f:
        cfg = dict(DEFAULTS, **json.load(f))
    cfg["mac"] = cfg["mac"].upper()

    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(APP, OUT)
    # The UI is the same web/ folder the MAG uses. Only the page's script tags
    # change: add LG's webOS library and the TV transport before app.js.
    with open(os.path.join(ROOT, "web", "index.html")) as f:
        page = f.read()
    anchor = '<script src="app.js"></script>'
    if anchor not in page:
        sys.exit("web/index.html changed: update build.py's script anchor")
    page = page.replace(anchor,
                        '<script src="webOSTVjs-1.2.13/webOSTV.js"></script>\n'
                        '<script src="transport.js"></script>\n' + anchor)
    with open(os.path.join(OUT, "index.html"), "w") as f:
        f.write(page)
    shutil.copy(os.path.join(ROOT, "web", "app.js"), OUT)
    shutil.copy(os.path.join(ROOT, "web", "app.css"), OUT)
    with open(os.path.join(OUT, "service", "config.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    with open(os.path.join(OUT, "icon.png"), "wb") as f:
        f.write(png(80, 80, (0x2b, 0x6c, 0xb0)))
    lib_dir = os.path.join(OUT, "webOSTVjs-1.2.13")
    os.makedirs(lib_dir)
    shutil.copy(find_webos_lib(), lib_dir)
    print("staged", OUT)


if __name__ == "__main__":
    main()
