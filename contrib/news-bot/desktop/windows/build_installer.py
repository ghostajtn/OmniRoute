#!/usr/bin/env python3
"""Builds NewsRadar-Setup.exe, the Windows installer (about 30 MB).

    python3 contrib/news-bot/desktop/windows/build_installer.py [NewsRadar-Setup.exe]

Needs makensis (NSIS, `apt install nsis`) and internet the first time, to fetch Node.js for
Windows. The Node.js download is checked against the SHA-256 published at nodejs.org and
cached in ~/.cache/news-radar-build. node.exe is bundled in the installer so installing needs
no download.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))  # contrib/news-bot
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "NewsRadar-Setup.exe")

NODE_VERSION = "22.22.2"
# SHA-256 of node-v22.22.2-win-x64.zip, from https://nodejs.org/dist/v22.22.2/SHASUMS256.txt
NODE_SHA256 = "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip"

PROGRAM_FILES = (
    ["newsBot.mjs", "package.json", "desktop/server.mjs"]
    + [
        f"lib/{name}"
        for name in sorted(os.listdir(os.path.join(ROOT, "lib")))
        if name.endswith(".mjs") and name != "nextRun.mjs"
    ]
    + [
        "app/index.html",
        "app/manifest.webmanifest",
        "app/icon.svg",
        "app/icon-192.png",
        "app/icon-512.png",
        "app/icon-maskable-512.png",
        "app/apple-touch-icon.png",
    ]
)


def node_zip():
    cache = os.path.join(os.path.expanduser("~"), ".cache", "news-radar-build")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, os.path.basename(NODE_URL))

    def digest(p):
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    if not (os.path.exists(path) and digest(path) == NODE_SHA256):
        print(f"Downloading {NODE_URL}")
        urllib.request.urlretrieve(NODE_URL, path)
    if digest(path) != NODE_SHA256:
        os.remove(path)
        sys.exit("The Node.js download did not match its published SHA-256. Not building.")
    return path


def main():
    if not shutil.which("makensis"):
        sys.exit("makensis not found. Install NSIS (for example: apt install nsis).")
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]

    stage = tempfile.mkdtemp(prefix="news-radar-stage-")
    try:
        for rel in PROGRAM_FILES:
            dest = os.path.join(stage, "program", rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(os.path.join(ROOT, rel), dest)
        shutil.copyfile(os.path.join(HERE, "News Radar.vbs"), os.path.join(stage, "News Radar.vbs"))
        shutil.copyfile(os.path.join(HERE, "news-radar.ico"), os.path.join(stage, "news-radar.ico"))

        node_dir = os.path.join(stage, "node")
        os.makedirs(node_dir)
        with zipfile.ZipFile(node_zip()) as z:
            for member, name in (("node.exe", "node.exe"), ("LICENSE", "LICENSE")):
                with z.open(f"node-v{NODE_VERSION}-win-x64/{member}") as src:
                    with open(os.path.join(node_dir, name), "wb") as dst:
                        shutil.copyfileobj(src, dst)

        subprocess.run(
            [
                "makensis",
                "-V2",
                f"-DSTAGE={stage}",
                f"-DOUTFILE={OUT}",
                f"-DVERSION={version}",
                os.path.join(HERE, "installer.nsi"),
            ],
            check=True,
        )
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    print(f"{OUT}: {os.path.getsize(OUT):,} bytes")


main()
