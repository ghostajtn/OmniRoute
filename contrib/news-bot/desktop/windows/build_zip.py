#!/usr/bin/env python3
"""Builds the Windows download: NewsRadar-Windows.zip (about 200 KB).

    python3 contrib/news-bot/desktop/windows/build_zip.py [output.zip]

Unzipped, it holds "News Radar.bat", README.txt and a "program" folder with the bot, the app and
the Windows setup script. The first start downloads a private copy of Node.js (checksum-checked).
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))  # contrib/news-bot
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "NewsRadar-Windows.zip")
STAMP = (2026, 1, 1, 0, 0, 0)  # fixed, so the same files always give the same zip

PROGRAM_FILES = (
    ["newsBot.mjs", "package.json", "desktop/server.mjs"]
    + [f"lib/{name}" for name in sorted(os.listdir(os.path.join(ROOT, "lib"))) if name.endswith(".mjs") and name != "nextRun.mjs"]
    + [
        "app/index.html",
        "app/manifest.webmanifest",
        "app/icon.svg",
        "app/icon-192.png",
        "app/icon-512.png",
        "app/icon-maskable-512.png",
        "app/apple-touch-icon.png",
        "desktop/windows/setup.ps1",
        "desktop/windows/news-radar.ico",
    ]
)


def add(zf, arcname, data):
    info = zipfile.ZipInfo(arcname, STAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


with zipfile.ZipFile(OUT, "w") as zf:
    for name in ("News Radar.bat", "README.txt"):
        with open(os.path.join(HERE, name), "rb") as f:
            add(zf, f"NewsRadar/{name}", f.read())
    for rel in PROGRAM_FILES:
        with open(os.path.join(ROOT, rel), "rb") as f:
            # desktop/windows/* sits in program/windows/ inside the zip
            arc = rel.replace("desktop/windows/", "windows/")
            add(zf, f"NewsRadar/program/{arc}", f.read())

print(f"{OUT}: {os.path.getsize(OUT):,} bytes, {len(PROGRAM_FILES) + 2} files")
