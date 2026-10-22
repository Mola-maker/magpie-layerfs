#!/usr/bin/env python3
"""Render a captured terminal log as a PNG 'screenshot' (dark terminal).

Usage: render_shots.py "window title" input.log output.png
The text is the program's real output, re-rendered for readability.
"""
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

TITLE, LOG, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SCALE = 2
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FS = 15 * SCALE
PAD = 22 * SCALE
BAR = 34 * SCALE
WRAP = 116

lines = []
for raw in open(LOG, encoding="utf-8").read().splitlines():
    lines.extend(textwrap.wrap(raw, WRAP, replace_whitespace=False, drop_whitespace=False) or [""])

font = ImageFont.truetype(FONT, FS)
font_b = ImageFont.truetype(FONT_B, FS)
probe = Image.new("RGB", (10, 10))
pd = ImageDraw.Draw(probe)
char_w = pd.textlength("M", font=font)
line_h = int(FS * 1.45)
width = int(PAD * 2 + char_w * WRAP) + 8 * SCALE
height = BAR + PAD + line_h * len(lines) + PAD

img = Image.new("RGB", (width, height), (13, 17, 23))
d = ImageDraw.Draw(img)
d.rectangle([0, 0, width, BAR], fill=(22, 27, 34))
for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    x = PAD // 2 + i * 18 * SCALE
    d.ellipse([x, BAR // 2 - 6 * SCALE, x + 12 * SCALE, BAR // 2 + 6 * SCALE], fill=c)
tf = ImageFont.truetype(FONT, 12 * SCALE)
d.text((PAD + 54 * SCALE, BAR // 2 - int(12 * SCALE * 0.62)), TITLE, font=tf, fill=(139, 148, 158))

y = BAR + PAD
for ln in lines:
    color = (230, 237, 243)
    f = font
    if "(pass)" in ln or " 0 fail" in ln or "dedup ratio" in ln or "TOTAL disk" in ln:
        color = (63, 185, 80)
    if ln.startswith("fixture") or ln.startswith("paths the agents"):
        f = font_b
    d.text((PAD, y), ln, font=f, fill=color)
    y += line_h

img.save(OUT)
print(f"{OUT}: {img.size[0]}x{img.size[1]}")
