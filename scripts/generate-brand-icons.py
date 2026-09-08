"""Regenerate all app icons and frontend logo assets from the brand sources.

Sources live in docs/brand/ and are the only files to replace when a
higher-resolution or vector-exported logo becomes available:

    docs/brand/alj-mark.png      square mark, used for every app icon
    docs/brand/alj-wordmark.png  horizontal lockup, used for the sidebar logo

Usage (from the repository root):

    python scripts/generate-brand-icons.py

Requires Pillow. Transparent padding in the sources is trimmed automatically,
so the sources do not need to be pre-cropped.
"""
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MARK_SRC = ROOT / "docs" / "brand" / "alj-mark.png"
WIDE_SRC = ROOT / "docs" / "brand" / "alj-wordmark.png"
ICONS = ROOT / "frontend" / "src-tauri" / "icons"
PUBLIC = ROOT / "frontend" / "public"

LANCZOS = Image.Resampling.LANCZOS

# Every square PNG Tauri bundles, mapped to its pixel size.
PLAIN_ICONS = {
    "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256,
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    "icon.png": 1024,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310, "StoreLogo.png": 50,
}

ICO_SIZES = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]

# PNG-backed ICNS OSTypes, which macOS reads natively.
ICNS_TYPES = [("icp4", 16), ("icp5", 32), ("ic07", 128),
              ("ic08", 256), ("ic09", 512), ("ic10", 1024)]


def trimmed(path):
    """Load an image and crop away its fully transparent border."""
    image = Image.open(path).convert("RGBA")
    return image.crop(image.getchannel("A").getbbox())


def square(mark, size, pad_ratio=0.06):
    """Center `mark` on a transparent square canvas of `size` pixels."""
    inner = round(size * (1 - 2 * pad_ratio))
    width, height = mark.size
    scale = min(inner / width, inner / height)
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = mark.resize(new_size, LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - new_size[0]) // 2, (size - new_size[1]) // 2), resized)
    return canvas


def fit(image, size, pad_ratio=0.04):
    """Center `image` on a transparent canvas of `size`, preserving aspect."""
    canvas_w, canvas_h = size
    inner_w = round(canvas_w * (1 - 2 * pad_ratio))
    inner_h = round(canvas_h * (1 - 2 * pad_ratio))
    width, height = image.size
    scale = min(inner_w / width, inner_h / height)
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = image.resize(new_size, LANCZOS)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.paste(resized, ((canvas_w - new_size[0]) // 2, (canvas_h - new_size[1]) // 2), resized)
    return canvas


def write_icns(mark, dest):
    """Write a minimal ICNS container holding one PNG per OSType."""
    blobs = b""
    for ostype, size in ICNS_TYPES:
        scratch = dest.parent / f".__{ostype}.png"
        square(mark, size).save(scratch, "PNG")
        data = scratch.read_bytes()
        scratch.unlink()
        blobs += ostype.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    dest.write_bytes(b"icns" + struct.pack(">I", len(blobs) + 8) + blobs)


def main():
    mark = trimmed(MARK_SRC)
    wordmark = trimmed(WIDE_SRC)
    print(f"mark {mark.size}, wordmark {wordmark.size}")

    for name, size in PLAIN_ICONS.items():
        square(mark, size).save(ICONS / name, "PNG")
    print(f"wrote {len(PLAIN_ICONS)} PNG icons")

    for name in ("icon.ico", "app_icon.ico"):
        square(mark, 256).save(ICONS / name, "ICO", sizes=ICO_SIZES)
    for name in ("icon.icns", "app_icon.icns"):
        write_icns(mark, ICONS / name)
    print("wrote .ico and .icns bundles")

    square(mark, 500).save(PUBLIC / "logo-collapsed.png", "PNG")
    square(mark, 128).save(PUBLIC / "icon_128x128.png", "PNG")
    square(mark, 64).save(PUBLIC / "icon_32x32@2x.png", "PNG")
    fit(wordmark, (845, 295)).save(PUBLIC / "logo.png", "PNG")
    print("wrote frontend/public logo assets")


if __name__ == "__main__":
    main()
