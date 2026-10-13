"""Makes four beatmap archives from a fixture map, for the checks in e2e_test.py:

  video.osz          a Video event at 0 ms and a 30 second WebM clip in the archive
  video-missing.osz  a Video event for a file that is not in the archive (nothing should play)
  beatmap-skin.osz   a hitcircle.png in the archive, which the map's own skin supplies
  flv.osz            a 3 second FLV clip, which browsers cannot play, so it is converted (transcode.js)

It also writes converted.webm, a 3 second WebM clip. The e2e test hands that back in place of the
converter's output, because the real ffmpeg.wasm cannot be reached from the test sandbox.

Needs ffmpeg with libvpx, and PIL. Usage: python3 make_video_fixture.py FIXTURE.osz OUT_DIR
"""
import io
import os
import re
import subprocess
import sys
import zipfile

from PIL import Image, ImageDraw

CLIP_SECONDS = 30


def make_clip(path):
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25",
         "-t", str(CLIP_SECONDS), "-c:v", "libvpx", "-b:v", "300k",
         "-deadline", "realtime", "-cpu-used", "8", path],
        check=True,
    )


def make_flv(path):
    # Sorenson H.263 in FLV, the codec of many older beatmap videos.
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25",
         "-t", "3", "-c:v", "flv1", path],
        check=True,
    )


def make_converted(path):
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25",
         "-t", "3", "-c:v", "libvpx", "-b:v", "300k",
         "-deadline", "realtime", "-cpu-used", "8", path],
        check=True,
    )


def hitcircle_png():
    """A 128 px circle in a magenta that is easy to recognise, as a beatmap's own hit circle image."""
    img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((2, 2, 125, 125), fill=(255, 0, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def rebuild(src, dst, event=None, extra=()):
    """Copies the archive. A Video event (if given) goes under [Events] in every difficulty;
    extra is a list of (name, bytes) files to add."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if event and info.filename.endswith(".osu"):
                text = data.decode("utf-8")
                text, n = re.subn(r"(\[Events\]\r?\n)", lambda m: m.group(1) + event + "\n", text, count=1)
                if n != 1:
                    raise SystemExit(f"no [Events] section in {info.filename}")
                data = text.encode("utf-8")
            zout.writestr(info.filename, data)
        for name, data in extra:
            zout.writestr(name, data)
    return dst


def make(src, out_dir):
    clip = os.path.join(out_dir, "clip.webm")
    if not os.path.exists(clip):
        make_clip(clip)
    with open(clip, "rb") as f:
        clip_bytes = f.read()
    video = rebuild(src, os.path.join(out_dir, "video.osz"), 'Video,0,"clip.webm"', [("clip.webm", clip_bytes)])
    missing = rebuild(src, os.path.join(out_dir, "video-missing.osz"), 'Video,0,"gone.mp4"')
    skin = rebuild(src, os.path.join(out_dir, "beatmap-skin.osz"), extra=[("hitcircle.png", hitcircle_png())])
    flv = os.path.join(out_dir, "clip.flv")
    if not os.path.exists(flv):
        make_flv(flv)
    with open(flv, "rb") as f:
        flv_bytes = f.read()
    flv_osz = rebuild(src, os.path.join(out_dir, "flv.osz"), 'Video,0,"clip.flv"', [("clip.flv", flv_bytes)])
    converted = os.path.join(out_dir, "converted.webm")
    if not os.path.exists(converted):
        make_converted(converted)
    return video, missing, skin, flv_osz


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make_video_fixture.py FIXTURE.osz OUT_DIR")
    for path in make(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])):
        print(path)
