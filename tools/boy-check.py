"""验茶馆小二：桥是否真的双向通。

## 为什么这个探针结构与众不同

**不能用 `--virtual-time-budget`。** 本项目其它探针都用它，但小二的桥
依赖 iframe 真的活够一段时间（见下），虚拟时钟会把定时器瞬间快进掉，
于是「等 60 秒」在真实世界里可能只过了 1 秒 —— 探针会得到假阴性。
所以这里走 **CDP + 真实时钟**，每 2 秒取样一次。

## 为什么要等

实测（2026 起持续复现）：`file://` 页面里，`sandbox="allow-scripts"` 的
blob iframe 刚挂上时，父窗口拿到的 `frame.contentWindow` **可能还是 null**。
父窗口正是拿它当 postMessage 的目标 —— 那一条 config 回执就丢了。
早期帧只报一次户口，于是**永久**停在未就绪，脚本 await 什么都超时，
而页面毫无报错（典型静默降级）。修法是帧侧每 400ms 重报 hello 直到就绪。

这个探针因此必须断言**往返真的完成**，而不是"帧脚本跑了就行"。

## 断言（全部要过，缺一即失败）
  1. 进入自由模式的茶馆，小二按钮存在且可见
  2. 面板打开，开关组与 iframe 都在
  3. iframe 的 sandbox 正是 allow-scripts，且隔离生效（读不到 contentDocument）
  4. 帧内脚本真的跑起来（frame-ran）
  5. **握手完成**：帧收到 ready（说明父→帧的通道通）
  6. **引擎真值可读**：read.turn() 返回数字（说明往返真实发生）
  7. **只读档拒绝写入**：write.set 被拒，且拒绝理由来自引擎
  8. 全程零 JS 报错
"""
import base64, io, json, os, re, socket, struct, subprocess, time, urllib.request

# ── 帧内脚本 ──────────────────────────────────────────────────────────
# 每一阶段都 postMessage 出来（父窗口读不到 opaque origin 的里面，
# 所以只能让它自己把结果送出来 —— 这用的正是它本来的能力）。
BOY_SCRIPT = (
    '<div id="out">待命</div>'
    '<scr' + 'ipt>\n'
    'function R(p) { try { parent.postMessage({ __probe: true, payload: p }, "*"); } catch (e) {} }\n'
    'R({ k: "frame-ran" });\n'
    'teahouse.on("ready", function () {\n'
    '  R({ k: "ready", mode: teahouse.meta.mode, strict: teahouse.meta.strict });\n'
    '  teahouse.read.turn().then(function (t) {\n'
    '    R({ k: "turn", v: t, type: typeof t });\n'
    '  }).catch(function (e) { R({ k: "turnfail", v: e.message }); });\n'
    '  /* 注意：read.nope 根本不存在（read 是固定键的对象），\n'
    '     所以 teahouse.read.nope() 是**同步抛错**，不是 reject ——\n'
    '     必须用 try/catch 接，挂 .catch 是接不到的。 */\n'
    '  try {\n'
    '    teahouse.read.nope();\n'
    '    R({ k: "readShouldFail" });\n'
    '  } catch (e) { R({ k: "readRejected", v: e.message }); }\n'
    '  /* 同理：只读档下 write.set 由 writable() 同步抛错 */\n'
    '  try {\n'
    '    teahouse.write.set("flags.x", 1);\n'
    '    R({ k: "writeShouldFail" });\n'
    '  } catch (e) { R({ k: "writeRejected", v: e.message }); }\n'
    '});\n'
    '</scr' + 'ipt>'
)

HOOK = r'''<script>
window.__errs = [];
window.__ech = [];
window.addEventListener('error', e => window.__errs.push(String(e.message) + ' @' + e.lineno));
window.addEventListener('unhandledrejection', e => window.__errs.push('REJ:' + String(e.reason)));
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (d && d.__probe === true) window.__ech.push({ at: Date.now(), p: d.payload });
});
</script>'''

TAIL = r'''<script>
(function () {
  window.__log = [];
  function L(k, v) { window.__log.push(k + '=' + v); }
  try {
    localStorage.setItem('ne.chat.driver', 'free');
    localStorage.setItem('ne.boy.config',
      JSON.stringify({ enabled: true, mode: 'readonly', strict: true }));
    localStorage.setItem('ne.boy.script', __BOY_SCRIPT__);
  } catch (e) { L('LS_ERR', String(e)); }

  window.__t0 = Date.now();
  window.__step = function () {
    var item = null;
    document.querySelectorAll('.boot-item').forEach(function (b) {
      if (b.textContent.indexOf('体验模式') >= 0) item = b;
    });
    if (!item) { L('启动页', '没有体验模式入口'); window.__done = true; return; }
    L('启动页', '有体验模式');
    item.click();
    setTimeout(function () {
      var boyBtn = null;
      document.querySelectorAll('.ne-icon-btn').forEach(function (b) {
        if (b.textContent.indexOf('小二') >= 0) boyBtn = b;
      });
      if (!boyBtn) { L('小二按钮', '不存在'); window.__done = true; return; }
      L('小二按钮存在', 'yes');
      L('小二按钮可见', !boyBtn.hidden);
      boyBtn.click();
      setTimeout(function () {
        var f = document.querySelector('.ne-boy-iframe');
        L('开关组在', !!document.querySelector('.ne-boy-switches'));
        L('iframe在', !!f);
        if (f) {
          L('iframe的sandbox', f.getAttribute('sandbox'));
          L('沙箱隔离生效', f.contentDocument === null);
        }
        L('面板已开', Date.now() - window.__t0 + 'ms');
        window.__done = true;
      }, 700);
    }, 600);
  };

  window.__snap = function () {
    var ech = (window.__ech || []).map(function (e) {
      return Math.round(e.at - window.__t0) + 'ms ' + JSON.stringify(e.p);
    });
    return JSON.stringify({
      log: window.__log,
      errs: window.__errs || [],
      ech: ech,
      elapsed: Date.now() - window.__t0,
    });
  };
})();
</script>'''


def ws_connect(url):
    m = re.match(r'ws://([^:/]+):(\d+)(/.*)', url)
    host, p, path = m.group(1), int(m.group(2)), m.group(3)
    sock = socket.create_connection((host, p), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n'
           'Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n'
           'Sec-WebSocket-Version: 13\r\n\r\n') % (path, host, p, key)
    sock.sendall(req.encode())
    buf = b''
    while b'\r\n\r\n' not in buf:
        buf += sock.recv(4096)
    return sock


def ws_send(sock, text):
    data = text.encode('utf-8')
    mask = os.urandom(4)
    ln = len(data)
    head = b'\x81'
    if ln < 126:
        head += bytes([0x80 | ln])
    elif ln < 65536:
        head += b'\x80\x7e' + struct.pack('>H', ln)
    else:
        head += b'\x80\x7f' + struct.pack('>Q', ln)
    sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(sock):
    def rd(n):
        b = b''
        while len(b) < n:
            c = sock.recv(n - len(b))
            if not c:
                raise EOFError
            b += c
        return b
    h = rd(2)
    ln = h[1] & 0x7F
    if ln == 126:
        ln = struct.unpack('>H', rd(2))[0]
    elif ln == 127:
        ln = struct.unpack('>Q', rd(8))[0]
    try:
        return rd(ln).decode('utf-8')
    except Exception:
        return ''


# ── 造探针页面 ────────────────────────────────────────────────────────
script = json.dumps(BOY_SCRIPT).replace('</', '<\\/')
tail = TAIL.replace('__BOY_SCRIPT__', script)
src = io.open('茶馆.html', encoding='utf-8').read()
out = src.replace('</head>', HOOK + '</head>', 1).replace('</html>', tail + '</html>', 1)
tmp = os.path.abspath('.tmp/boy-check.html')
io.open(tmp, 'w', encoding='utf-8', newline='').write(out)

# ── 起 Chrome + CDP ──────────────────────────────────────────────────
chrome = r'<HOME>/AppData/Local/Google/Chrome/Application/chrome.exe'
s = socket.socket()
s.bind(('127.0.0.1', 0))
port = s.getsockname()[1]
s.close()

proc = subprocess.Popen([
    chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
    '--force-device-scale-factor=1', '--window-size=1093,813',
    '--remote-debugging-port=%d' % port,
    '--user-data-dir=' + os.path.abspath('.tmp/cdp-boycheck'),
    'file:///' + tmp.replace('\\', '/'),
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(80):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/json' % port, timeout=1) as resp:
            tabs = json.loads(resp.read().decode('utf-8'))
        page = [t for t in tabs if t.get('type') == 'page']
        if page:
            ws_url = page[0]['webSocketDebuggerUrl']
            break
    except Exception:
        pass
    time.sleep(0.5)

if not ws_url:
    proc.kill()
    raise SystemExit('!! CDP 没起来')

sock = ws_connect(ws_url)
mid = [0]


def call(method, params=None):
    mid[0] += 1
    ws_send(sock, json.dumps({'id': mid[0], 'method': method, 'params': params or {}}))
    while True:
        msg = ws_recv(sock)
        if not msg:
            continue
        d = json.loads(msg)
        if d.get('id') == mid[0]:
            return d


time.sleep(2.5)
call('Runtime.enable')
call('Runtime.evaluate', {'expression': 'window.__step()'})

last = None
# 每 2 秒取样；一旦拿到 turn（往返真的完成）就提前收工，否则最多等 30 秒
for i in range(15):
    time.sleep(2)
    r = call('Runtime.evaluate', {'expression': 'window.__snap()', 'returnByValue': True})
    val = r.get('result', {}).get('result', {}).get('value')
    if not val:
        continue
    last = json.loads(val)
    kinds = [json.loads(e.split(' ', 1)[1]).get('k') for e in last['ech']]
    if 'turn' in kinds:
        break

proc.kill()

if last is None:
    print('!! 取样全空，探针没跑起来')
    raise SystemExit(1)

kinds = {}
for e in last['ech']:
    p = json.loads(e.split(' ', 1)[1])
    kinds[p.get('k')] = p

print('外层 errs :', last['errs'] if last['errs'] else '[]（无报错）')
for s_ in last['log']:
    print('  ', s_)
print('帧内回音：')
for e in last['ech']:
    print('  ', e)

# ── 断言 ─────────────────────────────────────────────────────────────
fails = []
logmap = {}
for s_ in last['log']:
    if '=' in s_:
        k, v = s_.split('=', 1)
        logmap[k] = v


def need(cond, msg):
    if not cond:
        fails.append(msg)


need(not last['errs'], '有 JS 报错：%s' % last['errs'])
need(logmap.get('小二按钮存在') == 'yes', '小二按钮不存在')
need(logmap.get('小二按钮可见') == 'true', '小二按钮不可见（自由模式下应当可见）')
need(logmap.get('开关组在') == 'true', '开关组不在')
need(logmap.get('iframe在') == 'true', 'iframe 不在')
need(logmap.get('iframe的sandbox') == 'allow-scripts', 'sandbox 不是 allow-scripts')
need(logmap.get('沙箱隔离生效') == 'true', '沙箱没有隔离（父窗口读到了 contentDocument）')

need('frame-ran' in kinds, '帧内脚本没跑起来')
need('ready' in kinds, '握手没完成（帧内没等到 ready）—— 父→帧通道不通')
need('turn' in kinds, '读通道没回来（read.turn 没结果）')
if 'turn' in kinds:
    need(kinds['turn'].get('type') == 'number', 'read.turn 返回的不是数字：%r' % kinds['turn'])
    need(kinds['turn'].get('v') == 1, 'read.turn 应为 1（开局第一轮），实际 %r' % kinds['turn'].get('v'))
need('turnfail' not in kinds, 'read.turn 失败了：%s' % kinds.get('turnfail', {}).get('v'))

need('readRejected' in kinds, '不认识的读资源竟然成功了（应被拒）')
need('writeRejected' in kinds, '只读档竟然写进去了')
need('writeShouldFail' not in kinds, '只读档下写入没被拦住')
if 'writeRejected' in kinds:
    need('只读' in str(kinds['writeRejected'].get('v', '')),
         '写入被拒的理由不是「只读档」：%r' % kinds['writeRejected'].get('v'))

print()
if fails:
    print('✗ 小二桥检查失败（%d 项）：' % len(fails))
    for f in fails:
        print('   -', f)
    raise SystemExit(1)

print('✓ 小二桥通了：握手完成、引擎真值可读（turn=%s）、只读档拦住写入、全程零报错'
      % kinds['turn'].get('v'))
