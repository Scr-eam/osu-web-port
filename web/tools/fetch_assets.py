"""Fetches the game assets listed in assets/manifest.json into assets/osu-resources/.

The game also downloads them itself when it runs (and keeps them in the browser), so this is only
for running offline or keeping a local copy. Files come from a clone of ppy/osu-resources if
--from-clone is given, otherwise from GitHub at the commit named in the manifest.

Usage: python3 tools/fetch_assets.py [--from-clone PATH/TO/osu.Game.Resources]
These files are Attribution-NonCommercial 4.0 (ppy/osu-resources, LICENCE.md); do not redistribute them.
"""
import argparse
import json
import os
import shutil
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "assets", "osu-resources")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-clone", help="osu.Game.Resources folder of a clone of ppy/osu-resources")
    args = ap.parse_args()
    with open(os.path.join(WEB, "assets", "manifest.json")) as f:
        manifest = json.load(f)
    got = skipped = 0
    for rel in manifest["files"]:
        dest = os.path.join(OUT, rel)
        if os.path.exists(dest):
            skipped += 1
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if args.from_clone:
            shutil.copyfile(os.path.join(args.from_clone, rel), dest)
        else:
            with urllib.request.urlopen(manifest["base"] + rel, timeout=60) as res, open(dest, "wb") as out:
                shutil.copyfileobj(res, out)
        got += 1
    print(f"{got} downloaded, {skipped} already present, in {OUT}")


if __name__ == "__main__":
    main()
