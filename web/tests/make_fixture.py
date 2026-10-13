"""Builds a small .osz fixture: an osu!standard map (circles, a slider, a spinner) with a
12-second WAV song, packed as a zip with deflated entries.

Usage: python3 make_fixture.py OUT.osz
"""
import io
import math
import struct
import sys
import wave
import zipfile

MAP = """osu file format v14

[General]
AudioFilename: audio.wav
AudioLeadIn: 0
Mode: 0

[Metadata]
Title:Fixture Song
Artist:Test Artist
Version:Normal

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:7
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
1000,500,4,2,0,60,1,0

[Events]
//Break Periods
2,6800,7400

[HitObjects]
150,150,2000,5,0,0:0:0:0:
300,150,2500,1,0,0:0:0:0:
380,300,3000,6,0,L|540:300,1,160,2,0,0:0:0:0:
200,300,3800,5,0,0:0:0:0:
330,200,4300,1,0,0:0:0:0:
256,192,5200,12,0,6200,0:0:0:0:
120,320,6600,5,0,0:0:0:0:
400,320,7000,1,0,0:0:0:0:
"""


def song_wav(seconds=12.0, rate=22050):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            v = int(6000 * math.sin(2 * math.pi * 220 * i / rate))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def main():
    out = sys.argv[1]
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("Fixture Song (Test Artist) [Normal].osu", MAP)
        z.writestr("audio.wav", song_wav(), compress_type=zipfile.ZIP_DEFLATED)
    print("wrote", out)


if __name__ == "__main__":
    main()
