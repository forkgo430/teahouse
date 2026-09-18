"""拍卡片组件与正则面板的截图（两种主题）。

⚠️ 样式来源是**打包产物**里的 <style>，不是 ui/styles.css ——
   图标 mask（.ic-x 等）是 build.js 在打包时注入的，直接链 styles.css
   会看到「图标变成无名方框/@」的假象。这里从 茶馆.html 抠出真实 CSS。

用法：
  python tools/shot-card.py tea        -> screenshots/card-tea.png
  python tools/shot-card.py rainnight  -> screenshots/card-rainnight.png
"""
import io
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, 'screenshots')
os.makedirs(OUTDIR, exist_ok=True)

built = os.path.join(ROOT, '茶馆.html')
if not os.path.exists(built):
    sys.exit('先跑 node build.js —— 截图要用真实产物的 CSS')
html = io.open(built, encoding='utf-8').read()
styles = re.findall(r'<style>([\s\S]*?)</style>', html)
if not styles:
    sys.exit('产物里没找到 <style>')
CSS_TEXT = '\n'.join(styles)

theme = sys.argv[1] if len(sys.argv) > 1 else 'tea'
bodycls = 'mode-rainnight' if theme == 'rainnight' else ''

# 卡片样例：覆盖 stats（含分数条与自由文本行）/ list / 行内标记
CARD = """
<p class="ne-msg-text">她把伞靠在门边，没有进来，只站在门槛外看着你。</p>

<div class="ne-card ne-card-stats">
  <div class="ne-card-head"><span class="ne-card-title">状态栏</span></div>
  <div class="ne-card-row"><span class="ne-card-key">好感</span>
    <div class="ne-card-bar"><i style="width:34%"></i></div>
    <span class="ne-card-num">34</span></div>
  <div class="ne-card-row"><span class="ne-card-key">信任</span>
    <div class="ne-card-bar"><i style="width:12%"></i></div>
    <span class="ne-card-num">1 / 10</span></div>
  <div class="ne-card-row"><span class="ne-card-key">戒心</span>
    <div class="ne-card-bar"><i style="width:78%"></i></div>
    <span class="ne-card-num">78</span></div>
  <div class="ne-card-row"><span class="ne-card-note">她今晚不打算走。</span></div>
</div>

<!-- 引擎真值卡：带 ✓ 的是引擎算的，没带的是模型自己写的 -->
<div class="ne-card ne-card-stats">
  <div class="ne-card-head"><span class="ne-card-title">状态栏 · 引擎真值</span></div>
  <div class="ne-card-row"><span class="ne-card-note">第 3 天 · 深夜</span></div>
  <div class="ne-card-row"><span class="ne-card-note">自己的住处</span></div>
  <div class="ne-card-row"><span class="ne-card-key">林晚·信任</span>
    <div class="ne-card-bar"><i style="width:72%"></i></div>
    <span class="ne-card-num">72 / 100<span class="ne-truth">✓</span></span></div>
  <div class="ne-card-row"><span class="ne-card-key">林晚·不安</span>
    <div class="ne-card-bar"><i style="width:31%"></i></div>
    <span class="ne-card-num">31 / 100<span class="ne-truth">✓</span></span></div>
  <div class="ne-card-row"><span class="ne-card-key">已知线索</span>
    <span class="ne-card-val">3<span class="ne-truth">✓</span></span></div>
  <div class="ne-card-row"><span class="ne-card-key">模型自填的天气</span>
    <span class="ne-card-val">转冷</span></div>
</div>

<div class="ne-card ne-card-list">
  <div class="ne-card-head"><span class="ne-card-title">物品栏</span></div>
  <div class="ne-card-list">
    <div class="ne-card-item"><span class="ne-card-dot"></span><span class="ne-card-text">雨伞</span></div>
    <div class="ne-card-item"><span class="ne-card-dot"></span><span class="ne-card-text">门钥匙</span></div>
    <div class="ne-card-item"><span class="ne-card-dot"></span><span class="ne-card-text">一张折过的纸条</span></div>
  </div>
</div>

<p class="ne-msg-text">她看了你一眼 <span class="ne-tag">疲惫</span>，
精神 <span class="ne-inline-bar"><span class="ne-inline-bar-key">精神</span><span class="ne-card-bar"><i style="width:60%"></i></span><span class="ne-card-num">6</span></span>
—— 然后低下头。</p>
"""

# 正则面板样例
RX = """
<section class="ne-sec">
  <h3 class="ne-sec-title">正则后处理</h3>

  <div class="rx-entry" data-invalid="0">
    <div class="rx-main">
      <span class="rx-no">01</span>
      <div class="rx-pair">
        <input class="rx-in rx-in-find" value="［(状态栏|物品栏|背包|属性|在场)］">
        <span class="rx-arrow">→</span>
        <input class="rx-in rx-in-rep" value="[$1]">
      </div>
      <button class="rx-del"><i class="ic ic-x"></i></button>
    </div>
    <div class="rx-scope">
      <span class="rx-scope-label">作用</span>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">模型输出</span></label>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">玩家输入</span></label>
      <span class="rx-scope-sep"></span>
      <span class="rx-scope-label">送往</span>
      <label class="rx-check"><input class="rx-check-input" type="checkbox" checked><span class="rx-check-box"></span><span class="rx-check-text">显示</span></label>
      <label class="rx-check"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">提示词</span></label>
    </div>
  </div>

  <div class="rx-entry" data-invalid="0">
    <div class="rx-main">
      <span class="rx-no">02</span>
      <div class="rx-pair">
        <input class="rx-in rx-in-find" value="\\*([^*\\n]{1,40})\\*">
        <span class="rx-arrow">→</span>
        <input class="rx-in rx-in-rep" value="<em>$1</em>">
      </div>
      <button class="rx-del"><i class="ic ic-x"></i></button>
    </div>
    <div class="rx-scope">
      <span class="rx-scope-label">作用</span>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox" checked><span class="rx-check-box"></span><span class="rx-check-text">模型输出</span></label>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">玩家输入</span></label>
      <span class="rx-scope-sep"></span>
      <span class="rx-scope-label">送往</span>
      <label class="rx-check"><input class="rx-check-input" type="checkbox" checked><span class="rx-check-box"></span><span class="rx-check-text">显示</span></label>
      <label class="rx-check"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">提示词</span></label>
    </div>
  </div>

  <div class="rx-entry" data-invalid="1">
    <div class="rx-main">
      <span class="rx-no">03</span>
      <div class="rx-pair">
        <input class="rx-in rx-in-find" value="(未闭合">
        <span class="rx-arrow">→</span>
        <input class="rx-in rx-in-rep" value="x">
      </div>
      <button class="rx-del"><i class="ic ic-x"></i></button>
    </div>
    <div class="rx-scope">
      <span class="rx-scope-label">作用</span>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">模型输出</span></label>
      <label class="rx-check rx-check-src"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">玩家输入</span></label>
      <span class="rx-scope-sep"></span>
      <span class="rx-scope-label">送往</span>
      <label class="rx-check"><input class="rx-check-input" type="checkbox" checked><span class="rx-check-box"></span><span class="rx-check-text">显示</span></label>
      <label class="rx-check"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">提示词</span></label>
    </div>
    <p class="rx-err">正则不合法，已停用。改好即恢复。</p>
  </div>

  <div class="rx-add">
    <input class="ne-field-input rx-mini" placeholder="查找（正则）">
    <input class="ne-field-input rx-mini" placeholder="替换为">
    <div class="rx-add-scope">
      <label class="rx-check"><input class="rx-check-input" type="checkbox" checked><span class="rx-check-box"></span><span class="rx-check-text">显示</span></label>
      <label class="rx-check"><input class="rx-check-input" type="checkbox"><span class="rx-check-box"></span><span class="rx-check-text">提示词</span></label>
    </div>
    <button class="ne-btn rx-add-btn">添加规则</button>
  </div>

  <p class="ne-modal-warn">「显示」只改你看到的，「提示词」会让模型读到。前端卡请只勾显示。</p>
</section>
"""

HTML = f"""<!doctype html><meta charset="utf-8">
<style>{CSS_TEXT}</style>
<style>
  /* 截图专用：给面板一个纸张底色，并冻结所有动效（过度动画截不到终点） */
  * {{ transition: none !important; animation: none !important; }}
  html, body {{ margin: 0; padding: 0; background: #e9e3d6; }}
  .wrap {{ display: grid; grid-template-columns: 460px minmax(620px, 1fr); gap: 28px;
          padding: 28px; align-items: start; }}
  .col {{ background: #f6f2ea; border-radius: 14px; padding: 20px 22px;
          box-shadow: 0 1px 0 rgba(0,0,0,.05), 0 12px 30px -18px rgba(0,0,0,.4); }}
  .col h4 {{ margin: 0 0 14px; font-size: 12px; letter-spacing: .16em;
            color: rgba(0,0,0,.34); font-weight: 600; }}
  body.mode-rainnight {{ background: #0d1420; }}
  body.mode-rainnight .col {{ background: #141d2c; }}
  body.mode-rainnight .col h4 {{ color: rgba(255,255,255,.34); }}
</style>
<body class="{bodycls}">
<div class="wrap">
  <div class="col"><h4>消息里的结构化卡片</h4>{CARD}</div>
  <div class="col"><h4>设置 · 正则后处理</h4>{RX}</div>
</div>
</body>"""

tmp = tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8')
tmp.write(HTML)
tmp.close()

out = os.path.join(OUTDIR, f'card-{theme}.png')
cmd = [sys.executable, os.path.join(ROOT, 'tools', 'shot.py'),
       'file:///' + tmp.name.replace('\\', '/'), out, '3000', '0', '1600x820']
print(' '.join(cmd))
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stdout[-1500:])
print(r.stderr[-800:])
