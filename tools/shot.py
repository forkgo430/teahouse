#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
用系统 Chrome 拍真机尺寸截图。

为什么要这个脚本：`--window-size=1080,720` 得到的**不是** 1080x720 视口 ——
headless=new 会把窗口边框算进去，实测 1093x813 才等于 1080x720 视口，
而且截出来的 PNG 是 1093x813（多出来的部分是白边）。不裁的话，
交付的"1080x720 截图"其实是 1067x627 的视口，视口相关的 bug 照样漏。

实测对照（本机 Chrome）：
  --window-size=1080,720 -> innerWidth x innerHeight = 1067x627   ← 之前一直用错
  --window-size=1093,813 -> innerWidth x innerHeight = 1080x720   ← 正确

用法：
  python tools/shot.py <url> <输出.png> [等待毫秒=14000] [冻结动画=1]

依赖 Pillow（隔离环境）：
  <HOME>/.workbuddy/binaries/python/envs/default/Scripts/python.exe
"""

import subprocess
import sys
import tempfile
import os
from PIL import Image

CHROME = r"<HOME>\AppData\Local\Google\Chrome\Application\chrome.exe"

# 1093x813 窗口 == 1080x720 视口
WIN_W, WIN_H = 1093, 813
VIEW_W, VIEW_H = 1080, 720


def shoot(url, out_png, budget_ms=14000, freeze=False):
    if freeze:
        # 要定格"最终画面"必须关掉动画：--virtual-time-budget 与 CSS 动画
        # 交互不可靠，会在动画中途定格（画面全暗）
        freeze_css = "*{animation:none!important;transition:none!important}"
        tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w",
                                         encoding="utf-8")
        with open(url.replace("file:///", ""), encoding="utf-8") as f:
            html = f.read()
        tmp.write(html.replace("</head>", f"<style>{freeze_css}</style></head>"))
        tmp.close()
        url = "file:///" + tmp.name.replace("\\", "/")

    raw = os.path.abspath(out_png) + ".raw.png"
    cmd = [
        CHROME, "--headless=new", "--disable-gpu",
        "--run-all-compositor-stages-before-draw",
        # 本机 DPI 是 125%，不加这一条截出来是 1366x1016，按 1080 裁就会裁错区域
        "--force-device-scale-factor=1",
        f"--virtual-time-budget={budget_ms}",
        f"--window-size={WIN_W},{WIN_H}",
        f"--screenshot={raw}",
        url,
    ]
    subprocess.run(cmd, capture_output=True)
    if not os.path.exists(raw):
        raise SystemExit(f"Chrome 没产出截图：{raw}")

    img = Image.open(raw)
    if img.size != (VIEW_W, VIEW_H):
        # 窗口比视口大（headless 的边框补偿），裁掉右侧与下方的白边
        scale = img.size[0] / WIN_W
        box = (0, 0, round(VIEW_W * scale), round(VIEW_H * scale))
        img = img.crop(box).resize((VIEW_W, VIEW_H), Image.LANCZOS)
    img.save(out_png)
    os.remove(raw)
    print(f"{out_png}  {img.size[0]}x{img.size[1]}  (1080x720 视口)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    url = sys.argv[1]
    out = sys.argv[2]
    budget = int(sys.argv[3]) if len(sys.argv) > 3 else 14000
    freeze = len(sys.argv) > 4 and sys.argv[4] not in ("0", "false", "no")
    shoot(url, out, budget, freeze)
