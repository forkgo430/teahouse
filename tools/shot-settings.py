#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
拍设置面板的折叠效果（收拢态 / 展开态两张）。

`tools/shot.py` 拍的是初始页面，而设置面板要**点开齿轮**才出现，
折叠态还得真实点一下才看得见。「元素在」≠「样子对」。

用法：
  python tools/shot-settings.py
"""

import io
import os
import re
import subprocess

from PIL import Image

CHROME = r"<HOME>\AppData\Local\Google\Chrome\Application\chrome.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT = os.path.join(ROOT, '茶馆.html')
OUT_DIR = os.path.join(ROOT, 'screenshots')
TMP = os.path.join(ROOT, '.tmp')

VIEW = (1080, 720)

# 本机实测：--window-size=1093,813 -> 视口 1080x720。
# 差值随尺寸变，但对固定目标尺寸记下来最省事、也最不会骗自己。
WIN = (1093, 813)


def shoot(driver_js, out_png):
    html = io.open(PRODUCT, encoding='utf-8').read()
    html = html.replace('</html>', '<script>%s</script></html>' % driver_js)

    os.makedirs(TMP, exist_ok=True)
    tmp = os.path.join(TMP, '_shot-settings.html')
    with io.open(tmp, 'w', encoding='utf-8') as f:
        f.write(html)

    if os.path.exists(out_png):
        os.remove(out_png)

    r = subprocess.run([
        CHROME, '--headless=new', '--disable-gpu',
        '--force-device-scale-factor=1',
        '--hide-scrollbars',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=25000',
        '--window-size=%d,%d' % WIN,
        '--screenshot=' + out_png,
        'file:///' + tmp.replace('\\', '/'),
    ], capture_output=True, text=True, encoding='utf-8', errors='replace')

    if not os.path.exists(out_png):
        print('拍摄失败：', (r.stderr or '')[:500])
        return False

    im = Image.open(out_png).convert('RGB')
    if im.size != VIEW:
        print('  ⚠ 实拍 %s，期望 %s —— 按目标区域裁' % (im.size, VIEW))
        im = im.crop((0, 0, VIEW[0], VIEW[1]))
        im.save(out_png)
    print('  ✓ %s  %s' % (os.path.basename(out_png), Image.open(out_png).size))
    return True


DRIVER = r'''
(function () {
  const fire = (node) => {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    for (const t of ['pointerdown', 'pointerup', 'click']) {
      node.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, button: 0, pointerId: 1,
        clientX: r.left + Math.max(1, r.width / 2),
        clientY: r.top + Math.max(1, r.height / 2),
      }));
    }
    return true;
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find(n => (n.textContent || '').includes(text));

  (async () => {
    window.__log = [];

    // 1) 启动页 -> 「体验模式」（冒烟里验证过的路径，直达主界面、不进向导）
    await wait(900);
    const boot = [...document.querySelectorAll('.boot-item')]
      .find(n => (n.textContent || '').includes('体验模式'))
      || document.querySelector('.boot-item');
    fire(boot); await wait(1400);
    window.__log.push('boot=' + (boot ? (boot.textContent || '').trim().slice(0, 8) : 'none'));
    window.__log.push('main=' + !!document.querySelector('.ne-body'));

    // 折叠展开有 0.3s 过渡；headless 下 transition 推不到终点时
    // 截图会拍到半开的中间态。要拍「最终样子」就先掐掉过渡。
    const kill = document.createElement('style');
    kill.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(kill);

    // 2) 开设置 —— 顶栏图标按钮的文字在 .ne-btn-text 里，没有 title 属性
    const gear = [...document.querySelectorAll('.ne-icon-btn')]
      .find(n => (n.textContent || '').includes('设置'))
      || [...document.querySelectorAll('button')]
        .find(n => (n.textContent || '').trim() === '设置');
    fire(gear); await wait(1000);
    window.__log.push('gear=' + (gear ? 'hit' : 'MISS'));
    window.__log.push('modal=' + !!document.querySelector('.ne-modal-card'));

    // 3) 折叠态：全部收起 / 全部展开
    const want = ACT_WANT;
    for (const h of document.querySelectorAll('.ne-fold-head')) {
      const fold = h.closest('.ne-fold');
      if (fold.classList.contains('is-open') !== want) { fire(h); await wait(200); }
    }
    const folds = [...document.querySelectorAll('.ne-fold')];
    window.__log.push('folds=' + folds.length
      + '/open=' + folds.filter(f => f.classList.contains('is-open')).length);

    await wait(900);
    document.title = 'READY ' + window.__log.join(' | ');
  })();
})();
'''

os.makedirs(OUT_DIR, exist_ok=True)
for want, name in [(False, 'settings-collapsed'), (True, 'settings-open')]:
    js = DRIVER.replace('ACT_WANT', 'true' if want else 'false')
    print(name)
    shoot(js, os.path.join(OUT_DIR, name + '.png'))

print('\n完成')
