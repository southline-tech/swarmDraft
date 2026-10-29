"""Regenerate every app icon and installer bitmap from the two swarmDraft SVGs.

Run from apps/desktop/src-tauri:  python3 icons/source/generate.py
Needs cairosvg and Pillow. 16-32 px use the simplified small mark; larger sizes use the full mark.
Also refreshes apps/desktop/src/assets/logo PNGs and SVG copies used by AppLogo.
"""
import io
import struct
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "icons" / "source"
WEB = ROOT.parent / "src" / "assets" / "logo"
FULL = (SRC / "swarmdraft-icon.svg").read_bytes()
SMALL = (SRC / "swarmdraft-icon-small.svg").read_bytes()
SURFACE = (255, 255, 255)   # --ct-surface
TEXT = (0x2B, 0x26, 0x20)   # --ct-text
ACCENT = (0x2F, 0x5D, 0xA8)  # --ct-accent
PNGS = {"32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
        "StoreLogo.png": 50}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def render(px):
    svg = SMALL if px <= 32 else FULL
    png = cairosvg.svg2png(bytestring=svg, output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def render_small(px):
    png = cairosvg.svg2png(bytestring=SMALL, output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def write_ico(path, sizes):
    """ICO with one PNG entry per size, so each size gets its own artwork."""
    entries = []
    for s in sizes:
        b = io.BytesIO()
        render(s).save(b, "PNG")
        entries.append((s, b.getvalue()))
    head = struct.pack("<HHH", 0, 1, len(entries))
    off = 6 + 16 * len(entries)
    body = b""
    for s, data in entries:
        d = 0 if s >= 256 else s
        head += struct.pack("<BBBBHHII", d, d, 0, 0, 1, 32, len(data), off)
        off += len(data)
        body += data
    path.write_bytes(head + body)


def main():
    icons = ROOT / "icons"
    for name, px in PNGS.items():
        render(px).save(icons / name)
    write_ico(icons / "icon.ico", ICO_SIZES)
    render(1024).save(icons / "icon.icns")

    win = ROOT / "windows"
    literata = str(win / "fonts" / "Literata-Regular.ttf")
    # Onboarding tile used by every installer and uninstaller page (on the white page surface).
    tile = Image.new("RGB", (128, 128), SURFACE)
    mark = render(128)
    tile.paste(mark, (0, 0), mark)
    tile.save(win / "ob-logo.bmp")
    # Stock MUI header (150x57): mark + name.
    hdr = Image.new("RGB", (150, 57), SURFACE)
    mark = render(40)
    hdr.paste(mark, (6, 8), mark)
    ImageDraw.Draw(hdr).text((52, 28), "swarmDraft", font=ImageFont.truetype(literata, 15), fill=TEXT, anchor="lm")
    hdr.save(win / "nsis-header.bmp")
    # Stock MUI sidebar (164x314): mark, name, accent rule.
    sb = Image.new("RGB", (164, 314), SURFACE)
    mark = render(72)
    sb.paste(mark, (46, 64), mark)
    d = ImageDraw.Draw(sb)
    d.text((82, 168), "swarmDraft", font=ImageFont.truetype(literata, 26), fill=TEXT, anchor="mm")
    d.rectangle([0, 308, 163, 313], fill=ACCENT)
    sb.save(win / "nsis-sidebar.bmp")

    WEB.mkdir(parents=True, exist_ok=True)
    import shutil

    public = ROOT.parent / "public"
    public.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SRC / "swarmdraft-icon.svg", WEB / "swarmdraft-icon.svg")
    shutil.copy2(SRC / "swarmdraft-icon-small.svg", WEB / "swarmdraft-icon-small.svg")
    shutil.copy2(SRC / "swarmdraft-icon-small.svg", public / "favicon.svg")
    render_small(24).save(WEB / "swarmdraft-icon-24.png")
    render_small(48).save(WEB / "swarmdraft-icon-48.png")


if __name__ == "__main__":
    main()
