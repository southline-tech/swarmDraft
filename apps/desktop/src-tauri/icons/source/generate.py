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
# Pillow ICNS writer: OSType -> side length in pixels (see PIL/IcnsImagePlugin.py).
ICNS_SIZES = {
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic10": 1024,
    b"ic11": 32,
    b"ic12": 64,
}


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


def write_icns(path):
    """Build .icns from per-size renders (small mark at 32px and below, same as PNG/ICO)."""
    by_side = {px: render(px) for px in sorted(set(ICNS_SIZES.values()))}
    # Pillow saves ic07–ic14 from the 1024px image plus append_images keyed by width.
    largest = by_side[1024]
    append = [by_side[px] for px in sorted(by_side) if px != 1024]
    largest.save(path, format="ICNS", append_images=append)


def icns_png_chunk(path, otype=b"ic11"):
    """Return the PNG image stored in one ICNS chunk (e.g. ic11 = 32px slot)."""
    data = path.read_bytes()
    if data[:4] != b"icns":
        raise SystemExit(f"{path} is not ICNS")
    i = 8
    filesize = struct.unpack(">I", data[4:8])[0]
    while i < filesize:
        t = data[i : i + 4]
        ln = struct.unpack(">I", data[i + 4 : i + 8])[0]
        if ln < 8:
            raise SystemExit(f"bad ICNS chunk length at {i}")
        if t == otype:
            return Image.open(io.BytesIO(data[i + 8 : i + ln])).convert("RGBA")
        i += ln
    raise SystemExit(f"{path} missing chunk {otype!r}")


def verify_icns_32_matches_png(icns_path, png_path, tolerance=0):
    ref = Image.open(png_path).convert("RGBA")
    got = icns_png_chunk(icns_path, b"ic11")
    if ref.size != got.size:
        raise SystemExit(f"ICNS ic11 size {got.size} != {ref.size} from {png_path.name}")
    diff = Image.new("RGBA", ref.size)
    px_diff = 0
    for x in range(ref.width):
        for y in range(ref.height):
            a = ref.getpixel((x, y))
            b = got.getpixel((x, y))
            if a != b:
                px_diff += 1
    if px_diff > tolerance:
        raise SystemExit(
            f"ICNS 32px slot differs from {png_path.name} on {px_diff} pixels (tolerance {tolerance})"
        )


def main():
    icons = ROOT / "icons"
    for name, px in PNGS.items():
        render(px).save(icons / name)
    write_ico(icons / "icon.ico", ICO_SIZES)
    write_icns(icons / "icon.icns")
    verify_icns_32_matches_png(icons / "icon.icns", icons / "32x32.png")

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
