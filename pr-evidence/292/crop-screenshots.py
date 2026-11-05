#!/usr/bin/env python3
"""Trim empty background tail from full-page landing captures."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def crop_to_content(path: Path, pad: int = 16) -> tuple[int, int]:
    im = Image.open(path).convert('RGB')
    w, h = im.size
    bg = im.getpixel((0, 0))
    tol = 10

    def pixel_diff(p: tuple[int, int, int]) -> int:
        return sum(abs(int(p[i]) - int(bg[i])) for i in range(3))

    def row_has_content(y: int) -> bool:
        step = max(1, w // 80)
        for x in range(0, w, step):
            if pixel_diff(im.getpixel((x, y))) > tol:
                return True
        return False

    bottom = h - 1
    while bottom > 0 and not row_has_content(bottom):
        bottom -= 1

    crop_h = min(h, bottom + pad)
    if crop_h < h:
        im.crop((0, 0, w, crop_h)).save(path)
    return w, crop_h


if __name__ == '__main__':
    for arg in sys.argv[1:]:
        w, h = crop_to_content(Path(arg))
        print(f'{Path(arg).name}: {w}x{h}')
