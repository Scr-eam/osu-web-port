"""Builds a small .osk skin for the end-to-end test: skin.ini with combo colours, a few sprites
(hit circle, overlay, approach circle, digits) and a hit sound.

Usage: python3 make_skin_fixture.py OUT.osk
"""
import io
import math
import struct
import sys
import wave
import zipfile

from PIL import Image, ImageDraw, ImageFont

SKIN_INI = """[General]
Name: Test Skin

[Colours]
Combo1 : 0,255,0
Combo2 : 255,0,255
Combo3 : 0,128,255
"""


def disc(size):
    """White filled disc on a transparent square (the body is tinted by the combo colour)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([2, 2, size - 3, size - 3], fill=(255, 255, 255, 255))
    return img


def ring(size, width):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([2, 2, size - 3, size - 3], outline=(255, 255, 255, 255), width=width)
    return img


def digit(ch):
    img = Image.new("RGBA", (48, 64), (0, 0, 0, 0))
    font = ImageFont.load_default(size=56)
    ImageDraw.Draw(img).text((24, 32), ch, fill=(255, 255, 255, 255), font=font, anchor="mm")
    return img


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def click_wav(seconds=0.06, rate=22050):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            env = math.exp(-i / (rate * 0.01))
            v = int(12000 * env * math.sin(2 * math.pi * 1000 * i / rate))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def main():
    out = sys.argv[1]
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("skin.ini", SKIN_INI)
        z.writestr("hitcircle.png", png_bytes(disc(128)))
        z.writestr("hitcircleoverlay.png", png_bytes(ring(128, 6)))
        z.writestr("approachcircle.png", png_bytes(ring(128, 6)))
        for d in range(10):
            z.writestr(f"default-{d}.png", png_bytes(digit(str(d))))
        z.writestr("normal-hitnormal.wav", click_wav())
    print("wrote", out)


if __name__ == "__main__":
    main()
