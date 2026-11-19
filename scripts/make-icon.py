#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流量台图标生成器（原创）
设计：宫崎骏水彩风圆角方底 + 暖橙上升箭头(上传) + 天蓝下降箭头(下载)
       + 底部水彩波纹(流量意象) + 柔光星点。配色与界面 --up/--down 一致。
不依赖 numpy，仅用 PIL 原生绘制 + 随机柔光叠加模拟水彩质感。
输出：assets/icon.png (512) / icon-256.png (256) / icon.ico (多尺寸)
"""
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

random.seed(20261119)
OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)

S = 512
# 与 UI 变量一致的调色板
UP = (232, 145, 44)      # --up 暖橙
UP_L = (250, 195, 120)
DOWN = (107, 181, 221)   # --down 天蓝
DOWN_L = (170, 218, 240)
PAPER = (255, 250, 240)
SKY = (198, 228, 244)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def soft_ellipse(layer, box, color, alpha=255, blur=0):
    tmp = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(tmp).ellipse(box, fill=color + (alpha,))
    if blur:
        tmp = tmp.filter(ImageFilter.GaussianBlur(blur))
    layer.alpha_composite(tmp)


def make_bg():
    """暖纸到晴空的斜向渐变 + 边缘柔光"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)  # 左上→右下
            r = int(PAPER[0] * (1 - t) + SKY[0] * t)
            g = int(PAPER[1] * (1 - t) + SKY[1] * t)
            b = int(PAPER[2] * (1 - t) + SKY[2] * t)
            px[x, y] = (r, g, b, 255)
    # 柔光斑，模拟水彩晕染
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    soft_ellipse(glow, (-60, -80, 260, 220), (255, 236, 196), 90, 55)
    soft_ellipse(glow, (280, 250, 600, 580), (176, 216, 240), 80, 65)
    img = Image.alpha_composite(img, glow)
    img.putalpha(rounded_mask(S, 112))
    return img


def arrow_polygon(cx, cy, w, h, direction):
    """实心箭头：direction = 'up' / 'down'"""
    head = h * 0.42
    shaft = h - head
    half = w / 2
    head_w = w * 0.92
    if direction == "up":
        return [
            (cx, cy - h / 2),                       # 顶尖
            (cx + head_w / 2, cy - h / 2 + head),   # 头右
            (cx + half * 0.42, cy - h / 2 + head),
            (cx + half * 0.42, cy + h / 2),
            (cx - half * 0.42, cy + h / 2),
            (cx - half * 0.42, cy - h / 2 + head),
            (cx - head_w / 2, cy - h / 2 + head),
        ]
    return [
        (cx, cy + h / 2),
        (cx - head_w / 2, cy + h / 2 - head),
        (cx - half * 0.42, cy + h / 2 - head),
        (cx - half * 0.42, cy - h / 2),
        (cx + half * 0.42, cy - h / 2),
        (cx + half * 0.42, cy + h / 2 - head),
        (cx + head_w / 2, cy + h / 2 - head),
    ]


def draw_wave(draw, y, color, width, alpha, amp=14, phase=0):
    pts = []
    for x in range(40, S - 40, 4):
        yy = y + math.sin((x / 46) + phase) * amp + math.sin((x / 23) + phase * 1.7) * amp * 0.35
        pts.append((x, yy))
    draw.line(pts, fill=color + (alpha,), width=width, joint="curve")


def make_icon():
    img = make_bg()
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 底部水彩波纹（流量意象），三层错开
    for i, (y, col, a) in enumerate([
        (372, DOWN, 120), (392, DOWN_L, 150), (414, UP, 90)
    ]):
        draw_wave(d, y, col, 9 - i, a, amp=12 + i * 3, phase=i * 1.1)

    # 中心双箭：橙上升 + 蓝下降，交叠成"⇅"但不完全对称，保留动态感
    # 先用模糊底做柔光晕
    soft = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ds = ImageDraw.Draw(soft)
    ds.polygon(arrow_polygon(214, 214, 74, 210, "up"), fill=UP_L + (150,))
    ds.polygon(arrow_polygon(300, 282, 74, 210, "down"), fill=DOWN_L + (150,))
    soft = soft.filter(ImageFilter.GaussianBlur(16))
    layer.alpha_composite(soft)

    # 主体箭头，带浅色描边强化手绘感
    d = ImageDraw.Draw(layer)
    d.polygon(arrow_polygon(214, 214, 70, 202, "up"), fill=UP + (245,), outline=PAPER + (200,), width=3)
    d.polygon(arrow_polygon(300, 282, 70, 202, "down"), fill=DOWN + (245,), outline=PAPER + (200,), width=3)

    # 高光斑点（水彩留白）
    for (x, y, r, col, a) in [
        (196, 150, 9, (255, 245, 220), 190),
        (282, 330, 8, (235, 250, 255), 190),
        (240, 250, 5, (255, 255, 255), 150),
    ]:
        soft_ellipse(layer, (x - r, y - r, x + r, y + r), col, a, blur=2)

    # 星点闪光
    d = ImageDraw.Draw(layer)
    for (x, y, sz, col) in [
        (118, 112, 15, (255, 246, 210)),
        (392, 158, 11, (255, 250, 228)),
        (368, 342, 9, (232, 246, 255)),
    ]:
        d.line([(x - sz, y), (x + sz, y)], fill=col + (200,), width=3)
        d.line([(x, y - sz), (x, y + sz)], fill=col + (200,), width=3)
        d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(255, 255, 255, 230))

    img = Image.alpha_composite(img, layer)
    # 内描边玻璃质感
    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.rounded_rectangle([5, 5, S - 6, S - 6], radius=108, outline=(255, 255, 255, 110), width=3)
    img = Image.alpha_composite(img, edge)
    return img.convert("RGB")


def main():
    icon = make_icon()
    icon.save(OUT / "icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(OUT / "icon-256.png")
    # Windows ICO：常见系统尺寸全覆盖
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon.save(
        OUT / "icon.ico",
        format="ICO",
        sizes=sizes,
    )
    for f in ["icon.png", "icon-256.png", "icon.ico"]:
        p = OUT / f
        print(f"{f}: {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
