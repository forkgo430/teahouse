"""拍导入面板三种版式的截图（一眼核对"三份内容长得不一样"）。

⚠️ 样式来源是**打包产物**里的 <style>，不是 ui/styles.css ——
   图标 mask（.ic-x 等）是 build.js 打包时注入的，直接链 styles.css
   会看到「图标变成无名方框」的假象。这里从 茶馆.html 抠出真实 CSS。

做法：不启动整个 app（那要先过启动页、世界构建，慢且脆），
而是**复刻导入面板的 DOM 结构**，直接渲染三份样例内容。
面板本身的类是照 ui/app.js 的 el(...) 调用抄的，不是自己编的。

用法：
  python tools/shot-import.py tea        -> screenshots/import-tea.png
  python tools/shot-import.py rainnight  -> screenshots/import-rainnight.png
"""
import io
import os
import re
import subprocess
import sys

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

# 三份样例：结构与 ui/app.js 里 describeWorldbook / describeCharacter /
# describePreset 生成的 DOM **逐一对应**（改那边记得改这里）
PANELS = """
<div class="shot-wrap">

  <section class="shot-sec">
    <div class="shot-cap"><span class="shot-num">一</span>世界书 · 条目账</div>
    <div class="ne-modal-card shot-card">
      <div class="ne-import-cats">
        <button class="import-cat is-on"><i class="ic ic-world"></i>
          <span class="import-cat-title">世界书</span><span class="import-cat-sub">酒馆世界书 JSON</span></button>
        <button class="import-cat"><i class="ic ic-users"></i>
          <span class="import-cat-title">角色卡</span><span class="import-cat-sub">V1 / V2 JSON 或 PNG</span></button>
        <button class="import-cat"><i class="ic ic-settings"></i>
          <span class="import-cat-title">模式（预设）</span><span class="import-cat-sub">采样参数 + 系统提示</span></button>
      </div>
      <div class="ne-import-preview is-worldbook">
        <div class="imp-head">
          <span class="imp-count">37</span>
          <div class="imp-unit"><span class="imp-unit-main">条目</span>
            <span class="imp-unit-sub">启用 29 · 停用 8</span></div>
          <span class="imp-badge">雨与夜 · 世界观</span>
          <span class="imp-badge is-dim">2048 tokens</span>
        </div>
        <div class="imp-entries">
          <div class="imp-entry"><span class="imp-entry-key">雨夜 / 落雨 / 天黑</span><span class="imp-entry-order">#120</span></div>
          <div class="imp-entry"><span class="imp-entry-key">旧公寓 / 楼下 / 门铃</span><span class="imp-entry-order">#100</span></div>
          <div class="imp-entry"><span class="imp-entry-key">便利店 / 关东煮 / 收银台</span><span class="imp-entry-order">#90</span></div>
          <div class="imp-entry"><span class="imp-entry-key">（无关键词）</span><span class="imp-entry-order">#80</span></div>
          <div class="imp-entry is-more">还有 33 条…</div>
        </div>
      </div>
    </div>
  </section>

  <section class="shot-sec">
    <div class="shot-cap"><span class="shot-num">二</span>角色卡 · 名片</div>
    <div class="ne-modal-card shot-card">
      <div class="ne-import-cats">
        <button class="import-cat"><i class="ic ic-world"></i>
          <span class="import-cat-title">世界书</span><span class="import-cat-sub">酒馆世界书 JSON</span></button>
        <button class="import-cat is-on"><i class="ic ic-users"></i>
          <span class="import-cat-title">角色卡</span><span class="import-cat-sub">V1 / V2 JSON 或 PNG</span></button>
        <button class="import-cat"><i class="ic ic-settings"></i>
          <span class="import-cat-title">模式（预设）</span><span class="import-cat-sub">采样参数 + 系统提示</span></button>
      </div>
      <div class="ne-import-preview is-character">
        <div class="imp-idcard">
          <span class="imp-avatar">林</span>
          <div class="imp-who"><span class="imp-name">林晚晴</span>
            <span class="imp-spec">chara_card_v2</span></div>
        </div>
        <div class="imp-stats">
          <div class="imp-stat"><span class="imp-stat-label">trust</span><span class="imp-stat-val">30</span></div>
          <div class="imp-stat"><span class="imp-stat-label">mood</span><span class="imp-stat-val">50</span></div>
          <div class="imp-stat"><span class="imp-stat-label">guard</span><span class="imp-stat-val">40</span></div>
        </div>
        <div class="imp-marks">
          <div class="imp-mark"><span class="imp-mark-k">开场白</span><span class="imp-mark-v">3 条</span></div>
          <div class="imp-mark"><span class="imp-mark-k">内嵌设定</span><span class="imp-mark-v">12 条</span></div>
          <div class="imp-mark"><span class="imp-mark-k">标签</span><span class="imp-mark-v">都市、悬疑</span></div>
        </div>
        <blockquote class="imp-quote">她把伞靠在门边，没有进来，只站在门槛外看着你。雨顺着伞骨往下淌，在脚边积了一小滩。</blockquote>
      </div>
    </div>
  </section>

  <section class="shot-sec">
    <div class="shot-cap"><span class="shot-num">三</span>预设 · 参数表</div>
    <div class="ne-modal-card shot-card">
      <div class="ne-import-cats">
        <button class="import-cat"><i class="ic ic-world"></i>
          <span class="import-cat-title">世界书</span><span class="import-cat-sub">酒馆世界书 JSON</span></button>
        <button class="import-cat"><i class="ic ic-users"></i>
          <span class="import-cat-title">角色卡</span><span class="import-cat-sub">V1 / V2 JSON 或 PNG</span></button>
        <button class="import-cat is-on"><i class="ic ic-settings"></i>
          <span class="import-cat-title">模式（预设）</span><span class="import-cat-sub">采样参数 + 系统提示</span></button>
      </div>
      <div class="ne-import-preview is-preset">
        <div class="imp-head"><span class="imp-unit-main">写实叙事 v3</span></div>
        <div class="imp-params">
          <div class="imp-param"><span class="imp-param-k">温度 temperature</span><span class="imp-param-v">0.85</span></div>
          <div class="imp-param"><span class="imp-param-k">top_p</span><span class="imp-param-v">0.95</span></div>
          <div class="imp-param"><span class="imp-param-k">max_tokens</span><span class="imp-param-v">2048</span></div>
        </div>
        <div class="imp-prompt">
          <span class="imp-prompt-k">系统提示词</span>
          <div class="imp-prompt-v">你是一个克制的叙事者。用第二人称写，短句为主，不解释角色的心理活动，只写能看见的动作与对白。每次回复控制在 200 字以内。</div>
        </div>
      </div>
    </div>
  </section>

</div>
"""

SHOT_CSS = """
html, body { margin: 0; padding: 0; }
body {
  font: 13px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  padding: 22px;
  min-height: 100vh;
}
.shot-wrap { display: flex; gap: 20px; align-items: flex-start; }
.shot-sec { flex: 1 1 0; min-width: 0; }
.shot-cap {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; letter-spacing: 0.1em; margin-bottom: 8px;
}
.shot-num {
  display: grid; place-items: center;
  width: 18px; height: 18px; border-radius: 50%;
  font-size: 10px; border: 1px solid currentColor; opacity: 0.7;
}
/* 面板本身在真 app 里是浮层，这里让它就地排开方便并排看 */
.shot-card { margin: 0; width: 100%; box-sizing: border-box; }
"""

page = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>%s</style>
<style>%s
.theme-probe { color: var(--ink); }
</style>
</head><body class="%s">%s</body></html>""" % (CSS_TEXT, SHOT_CSS, bodycls, PANELS)

tmp = os.path.join(ROOT, '.tmp', 'shot-import.html')
io.makedirs = os.makedirs
os.makedirs(os.path.dirname(tmp), exist_ok=True)
io.open(tmp, 'w', encoding='utf-8', newline='').write(page)

out = os.path.join(OUTDIR, 'import-%s.png' % theme)
chrome = r'<HOME>/AppData/Local/Google/Chrome/Application/chrome.exe'
r = subprocess.run([
    chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
    '--force-device-scale-factor=1',
    # 并排三栏，视口要宽：1584 = 3 栏 ×520 + 间隙
    '--window-size=1584,760',
    '--hide-scrollbars',
    '--screenshot=' + out,
    'file:///' + tmp.replace('\\', '/'),
], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)

print('产物:', out)
if r.stderr.strip():
    print('chrome stderr:', r.stderr.strip()[:400])
