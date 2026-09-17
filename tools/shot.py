#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
用系统 Chrome 拍真机尺寸截图。

为什么需要这个脚本：`--window-size` **不是**视口尺寸。headless=new 会把
窗口边框算进去，而且补偿量**随尺寸变化**（不是固定 13x93）：

  --window-size=1080,720 -> 视口 1067x627
  --window-size=1093,813 -> 视口 1080x720
  --window-size=403,937  -> 视口  484x842   ← 换小尺寸就完全不是那回事

本机 DPI 是 125%，还要加 `--force-device-scale-factor=1`，
否则截出来是 1366x1016，按 1080 裁会裁错区域。

所以这里不写死常量，而是**先量一次**：跑一个只输出 innerWidth/innerHeight
的探针页，拿到该尺寸下的窗口→视口差值，再用差值反推窗口尺寸、正式拍。

用法：
  python tools/shot.py <url> <输出.png> [等待毫秒=14000] [冻结动画=1] [视口=1080x720]

换视口：
  python tools/shot.py x.html out.png 9000 0 484x842

⚠️ Chrome headless 有最小窗口限制，实测视口宽度缩不到 484 以下 ——
   想要 390（多数安卓机）会撞墙，脚本会退到能拿到的最小视口并如实报告。

依赖 Pillow（隔离环境）：
  <HOME>/.workbuddy/binaries/python/envs/default/Scripts/python.exe
"""

import re
import subprocess
import sys
import tempfile
import os
from PIL import Image

CHROME = r"<HOME>\AppData\Local\Google\Chrome\Application\chrome.exe"

VIEW_W, VIEW_H = 1080, 720


def _run(args):
    return subprocess.run([CHROME] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def _measure(win_w, win_h):
    """返回该窗口尺寸下的真实视口 (w, h)"""
    probe = os.path.join(tempfile.gettempdir(), "_viewport_probe.html")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("<!doctype html><html><body><script>"
                "document.title=innerWidth+'x'+innerHeight;"
                "</script></body></html>")
    r = _run([
        "--headless=new", "--disable-gpu", "--force-device-scale-factor=1",
        "--virtual-time-budget=1200",
        f"--window-size={win_w},{win_h}",
        "--dump-dom", "file:///" + probe.replace("\\", "/"),
    ])
    m = re.search(r"<title>(\d+)x(\d+)</title>", r.stdout or "")
    if not m:
        raise SystemExit("量视口失败：Chrome 没返回尺寸")
    return int(m.group(1)), int(m.group(2))


def shoot(url, out_png, budget_ms=14000, freeze=False, view=None):
    global VIEW_W, VIEW_H
    if view:
        VIEW_W, VIEW_H = view

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

    # 先探测拿到该尺寸下的窗口→视口差值，再按差值反推窗口尺寸。
    # 注意：Chrome 有**最小窗口**限制，实测视口宽度缩不到 484 以下 ——
    # 想要 390 这种手机宽度会一直撞墙，所以这里带收敛判定，
    # 撞墙时就用能拿到的最小视口，并在输出里如实报告。
    win_w, win_h = VIEW_W + 13, VIEW_H + 93
    got_w, got_h = _measure(win_w, win_h)
    for _ in range(3):
        if (got_w, got_h) == (VIEW_W, VIEW_H):
            break
        next_w = win_w + (VIEW_W - got_w)
        next_h = win_h + (VIEW_H - got_h)
        if next_w < 200 or next_h < 200:
            break
        probe_w, probe_h = _measure(next_w, next_h)
        if (probe_w, probe_h) == (got_w, got_h):
            # 窗口变了视口没变 → 撞到最小尺寸，别再缩
            break
        win_w, win_h = next_w, next_h
        got_w, got_h = probe_w, probe_h
    real_w, real_h = got_w, got_h

    raw = os.path.abspath(out_png) + ".raw.png"
    _run([
        "--headless=new", "--disable-gpu",
        "--run-all-compositor-stages-before-draw",
        "--force-device-scale-factor=1",
        f"--virtual-time-budget={budget_ms}",
        f"--window-size={win_w},{win_h}",
        f"--screenshot={raw}",
        url,
    ])
    if not os.path.exists(raw):
        raise SystemExit(f"Chrome 没产出截图：{raw}")

    img = Image.open(raw)
    scale = img.size[0] / win_w
    box = (0, 0, round(min(real_w, VIEW_W) * scale), round(min(real_h, VIEW_H) * scale))
    img = img.crop(box).resize((round(box[2] / scale), round(box[3] / scale)), Image.LANCZOS)
    img.save(out_png)
    os.remove(raw)
    note = "" if (real_w, real_h) == (VIEW_W, VIEW_H) else \
        f"  ！实际只能拿到 {real_w}x{real_h}（Chrome 最小窗口限制）"
    print(f"{out_png}  {img.size[0]}x{img.size[1]}  {note}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    url = sys.argv[1]
    out = sys.argv[2]
    budget = int(sys.argv[3]) if len(sys.argv) > 3 else 14000
    freeze = len(sys.argv) > 4 and sys.argv[4] not in ("0", "false", "no")
    view = None
    if len(sys.argv) > 5:
        w, h = sys.argv[5].lower().split("x")
        view = (int(w), int(h))
    shoot(url, out, budget, freeze, view)
