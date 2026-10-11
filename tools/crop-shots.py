"""把手机截图按内容自动裁边（去掉大片空白），并缩到合适宽度。"""
import sys, glob, os
from PIL import Image, ImageChops, ImageOps

BG = (13, 15, 19)          # 页面背景色 #0d0f13
THRESH = 10                # 与背景的差异阈值

def content_box(im, tol=THRESH):
    """找出与背景色不同的像素范围。"""
    bg = Image.new("RGB", im.size, BG)
    diff = ImageChops.difference(im.convert("RGB"), bg).convert("L")
    mask = diff.point(lambda v: 255 if v > tol else 0)
    return mask.getbbox()

def process(path, max_w, pad=14):
    im = Image.open(path).convert("RGB")
    box = content_box(im)
    if not box:
        print("  ! 全背景，跳过", path); return
    # 左右用完整宽度（画面是居中的，留白更好看），上下按内容裁
    x0, y0, x1, y1 = box
    y0 = max(0, y0 - pad); y1 = min(im.height, y1 + pad)
    im = im.crop((0, y0, im.width, y1))
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    im.save(path, "PNG", optimize=True)
    print("  %-28s -> %sx%s  %dKB" % (os.path.basename(path), im.width, im.height, os.path.getsize(path) // 1024))

if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else r"D:\ds\brake-simulator\shots"
    for f in sorted(glob.glob(os.path.join(d, "6*.png"))):
        process(f, max_w=760)
