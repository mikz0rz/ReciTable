#!/usr/bin/env python3
"""Generate the toolbar icons: a miniature recipe table, drawn at three sizes.

Pure stdlib PNG writing so the icons stay reproducible without an image library.

Usage: python3 extension/icons/make_icons.py
"""

import pathlib
import struct
import zlib

RULE = (31, 107, 59)  # --rule
SHEET = (255, 255, 255)
TINT = (216, 232, 210)  # a touch deeper than --tint so it reads at 16px


def write_png(path, size, pixel):
    """pixel(x, y) -> (r, g, b)"""
    raw = b"".join(
        b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(size)) for y in range(size)
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def make(size):
    border = max(1, round(size / 16))
    split = round(size * 0.58)  # ingredient column | operation column
    rows = [round(size * f) for f in (0.34, 0.58, 0.79)]

    def pixel(x, y):
        if x < border or y < border or x >= size - border or y >= size - border:
            return RULE
        if abs(x - split) < border:
            return RULE
        # Row rules only cross the ingredient column; the op cell spans them all.
        if x < split and any(abs(y - r) < border for r in rows):
            return RULE
        return TINT if x > split else SHEET

    return pixel


def main():
    out = pathlib.Path(__file__).resolve().parent
    for size in (16, 48, 128):
        write_png(out / f"icon{size}.png", size, make(size))
        print(f"icon{size}.png")


if __name__ == "__main__":
    main()
