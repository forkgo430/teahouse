/**
 * 音效引擎 —— 全部用 Web Audio 现场合成，也可加载任何音频文件。
 *
 * 
 * Web Audio 用几十行就能做出雨声、点击、翻页、成就、结局和弦 ——
 * 体积为零、断网可用、可随状态实时变化（雨随情绪变密）。
 *
 * 所有对外方法都是**安全空操作**：环境不支持或用户关掉声音时静静返回，不抛错。
 */

export function createAudio(options = {}) {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

  let ctx = null;
  let master = null;
  let rainChain = null;
  let noiseBuffer = null;

  const state = {
    enabled: options.enabled !== false,
    volume: typeof options.volume === 'number' ? options.volume : 0.45,
    ambient: options.ambient !== false,
    // 背景音乐是**独立开关**，跟音效分开：
    // 想要"别放音乐"的人不等于想要"别出声"，
    // 关掉 UI 音效会把按钮反馈一起带走，那是另一件事。
    bgmEnabled: options.bgmEnabled !== false,
    rainLevel: 0,
  };

  function ready() {
    if (ctx) return ctx;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = state.enabled ? state.volume : 0;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  /* ------------------------------------------------------------------ *
   * 采样音效：Kenney Interface Sounds（CC0）经构建内联为 data URI。
   * 占位符 __SND_*__ 由 build.js 替换；直接跑源码时是未替换状态，
   * playSample 会返回 false，自动回落到合成音 —— 两套都活着，永不哑火。
   * ------------------------------------------------------------------ */

  const SAMPLE_URIS = {
    hover: '__SND_HOVER__',
    pick: '__SND_PICK__',
    toggle: '__SND_TOGGLE__',
    begins: '__SND_BEGINS__',
    settles: '__SND_SETTLES__',
    unlock: '__SND_UNLOCK__',
    deny: '__SND_DENY__',
    confirm: '__SND_CONFIRM__',
    ending: '__SND_ENDING__',
    back: '__SND_BACK__',
    closePanel: '__SND_CLOSE__',
    select: '__SND_SELECT__',
    bong: '__SND_BONG__',
    dropped: '__SND_DROP__',
  };

  const buffers = Object.create(null);

  function isBundled(uri) {
    return typeof uri === 'string' && !uri.startsWith('__');
  }

  async function loadSample(name) {
    const c = ready();
    if (!c || buffers[name] !== undefined) return buffers[name] ?? null;
    const uri = SAMPLE_URIS[name];
    if (!isBundled(uri)) {
      buffers[name] = null;
      return null;
    }
    try {
      const res = await fetch(uri);
      const raw = await res.arrayBuffer();
      buffers[name] = await c.decodeAudioData(raw);
    } catch {
      buffers[name] = null;
    }
    return buffers[name];
  }

  /** 播放采样。返回 false 表示没有可用采样，调用方走合成。 */
  function playSample(name, vol = 0.5) {
    const c = ready();
    if (!c || !state.enabled) return true;
    const buf = buffers[name];
    if (!buf) return false;
    const src = c.createBufferSource();
    const gain = c.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain);
    gain.connect(master);
    src.start();
    return true;
  }

  function preloadAll() {
    for (const name of Object.keys(SAMPLE_URIS)) loadSample(name);
  }

  /** 浏览器要求先有用户交互才能出声 */
  function unlock() {
    const c = ready();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(() => {});
    preloadAll();
    return true;
  }

  function noise() {
    const c = ready();
    if (!c) return null;
    if (noiseBuffer) return noiseBuffer;

    const len = Math.floor(c.sampleRate * 3);
    noiseBuffer = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // 轻微的低通，比纯白噪声更像"雨"而不是"电视雪花"
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      data[i] = last * 3.2;
    }
    return noiseBuffer;
  }

  /* ---------------------------------------------------------------- *
   * 基础发声
   * ---------------------------------------------------------------- */

  /** 一段带包络的振荡，所有短音都由它派生 */
  function blip({ freq = 440, dur = 0.09, type = 'sine', vol = 0.12, endFreq = null, delay = 0 } = {}) {
    const c = ready();
    if (!c || !state.enabled) return;

    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** 一小段噪声脉冲：翻页、脚步、纸张 */
  function noiseBurst({ dur = 0.12, freq = 1800, q = 1.2, vol = 0.1, delay = 0 } = {}) {
    const c = ready();
    const buf = noise();
    if (!c || !buf || !state.enabled) return;

    const t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ---------------------------------------------------------------- *
   * 具体音色
   * ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- *
   * BGM
   *
   * 一首 CC0 氛围曲，内联成 data URI 循环播放。
   * 来源：OpenGameArt「ObservingTheStar」，CC0（检索时按 CC0 许可过滤）。
   * 原曲 2.1MB，按 MPEG 帧边界截到前 547KB（约 30 余秒）——
   * 循环点落在帧边界上，接缝听不出来。
   *
   * 走 master 增益：跟随总开关与音量，不必再做一套独立的音量 UI。
   * ---------------------------------------------------------------- */

  const BGM_SRC = '__SND_BGM__';
  const BGM_VOL = 0.42;
  const bgm = { buf: null, node: null, gain: null, loading: false, want: false };

  async function bgmStart() {
    bgm.want = true;              // want 记的是"这个场景想要音乐"，与开关分开 ——
                                  // 关掉再打开时 want 还在，音乐能自己回来
    if (!ctx || !state.enabled || !state.bgmEnabled || bgm.node) return;

    if (!bgm.buf) {
      if (bgm.loading) return;
      bgm.loading = true;
      try {
        const res = await fetch(BGM_SRC);
        bgm.buf = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) {
        bgm.loading = false;
        return;                      // 解不开就当没有 BGM，别影响别的声音
      }
      bgm.loading = false;
    }
    // 解码是异步的：回来时可能已经切走、关了音乐开关、或静音了
    if (!bgm.want || !state.enabled || !state.bgmEnabled || bgm.node) return;

    bgm.node = ctx.createBufferSource();
    bgm.node.buffer = bgm.buf;
    bgm.node.loop = true;            // 截在帧边界上，loop 接缝是干净的
    bgm.gain = ctx.createGain();
    bgm.gain.gain.value = 0;
    bgm.node.connect(bgm.gain);
    bgm.gain.connect(master);
    bgm.node.start();
    bgm.gain.gain.setTargetAtTime(BGM_VOL, ctx.currentTime, 1.8);
  }

  function bgmStop() {
    bgm.want = false;
    if (!bgm.node || !ctx) return;
    const node = bgm.node;
    const g = bgm.gain;
    bgm.node = null;
    bgm.gain = null;
    g.gain.setTargetAtTime(0, ctx.currentTime, 1.1);
    setTimeout(() => { try { node.stop(); } catch (e) {} }, 3200);
  }

  const api = {
    unlock,
    bgm: {
      start: bgmStart,
      stop: bgmStop,
      isOn: () => Boolean(bgm.node),
      isReady: () => Boolean(bgm.buf),
    },
    isReady: () => Boolean(ctx),
    isEnabled: () => state.enabled,
    isBgmEnabled: () => state.bgmEnabled,

    /** 背景音乐开关（不影响 UI 音效） */
    setBgmEnabled(on) {
      state.bgmEnabled = Boolean(on);
      if (!ctx) return;
      if (!state.bgmEnabled) bgmStop();
      else if (bgm.want && !bgm.node) bgmStart();
    },

    setEnabled(on) {
      state.enabled = Boolean(on);
      if (master) master.gain.value = state.enabled ? state.volume : 0;
    },

    setVolume(v) {
      state.volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (master && state.enabled) master.gain.value = state.volume;
    },

    /** 悬停：极轻的一下，几乎只是"有反应"的感觉 */
    hover() {
      blip({ freq: 1450, dur: 0.035, type: 'triangle', vol: 0.025 });
    },

    /** 点击选项 */
    pick() {
      blip({ freq: 520, endFreq: 780, dur: 0.13, type: 'triangle', vol: 0.1 });
      noiseBurst({ dur: 0.07, freq: 2600, q: 0.9, vol: 0.045, delay: 0.01 });
    },

    /** 面板开合 */
    toggle(open = true) {
      blip({ freq: open ? 380 : 300, endFreq: open ? 520 : 220, dur: 0.11, type: 'sine', vol: 0.07 });
    },

    /** 正文开始生成 */
    begins() {
      blip({ freq: 220, endFreq: 330, dur: 0.4, type: 'sine', vol: 0.05 });
      noiseBurst({ dur: 0.5, freq: 900, q: 0.6, vol: 0.03 });
    },

    /** 一段文字写完 */
    settles() {
      blip({ freq: 660, dur: 0.16, type: 'sine', vol: 0.055 });
      blip({ freq: 990, dur: 0.22, type: 'sine', vol: 0.035, delay: 0.06 });
    },

    /** 成就解锁：上行三音 */
    unlock() {
      [523.25, 659.25, 783.99].forEach((f, i) => {
        blip({ freq: f, dur: 0.34, type: 'triangle', vol: 0.075, delay: i * 0.085 });
      });
    },

    /** 结局：长和弦，慢慢铺开 */
    ending() {
      [130.81, 196.0, 261.63, 329.63].forEach((f, i) => {
        blip({ freq: f, dur: 2.6, type: 'sine', vol: 0.06, delay: i * 0.16 });
      });
      noiseBurst({ dur: 1.8, freq: 620, q: 0.5, vol: 0.04 });
    },

    /** 出错 / 走不通 */
    deny() {
      blip({ freq: 180, endFreq: 120, dur: 0.18, type: 'sawtooth', vol: 0.06 });
    },

    /** 存档成功 */
    confirm() {
      blip({ freq: 784, dur: 0.1, type: 'sine', vol: 0.07 });
      blip({ freq: 1046.5, dur: 0.14, type: 'sine', vol: 0.05, delay: 0.07 });
    },

    /** 后退 / 上一步：下行两音 */
    back() {
      blip({ freq: 560, endFreq: 400, dur: 0.09, type: 'triangle', vol: 0.06 });
      blip({ freq: 380, dur: 0.1, type: 'triangle', vol: 0.04, delay: 0.06 });
    },

    /** 关闭面板 / 取消：比 back 更闷，收尾感 */
    closePanel() {
      blip({ freq: 420, endFreq: 240, dur: 0.13, type: 'sine', vol: 0.06 });
    },

    /** 轻选（页签、模式切换）：一声干净的短点 */
    select() {
      blip({ freq: 880, dur: 0.055, type: 'triangle', vol: 0.055 });
      noiseBurst({ dur: 0.04, freq: 3200, q: 1.1, vol: 0.03 });
    },

    /** 重要的事（成就、关键线索）：低音钟 */
    bong() {
      blip({ freq: 196, dur: 0.9, type: 'sine', vol: 0.08 });
      blip({ freq: 392, dur: 0.6, type: 'sine', vol: 0.03, delay: 0.01 });
      blip({ freq: 587.33, dur: 0.4, type: 'sine', vol: 0.018, delay: 0.02 });
    },

    /** 东西落定（导入完成、放下物件） */
    dropped() {
      blip({ freq: 150, endFreq: 90, dur: 0.16, type: 'sine', vol: 0.08 });
      noiseBurst({ dur: 0.1, freq: 700, q: 0.7, vol: 0.04 });
    },

    /* -------------------------------------------------------------- *
     * 环境：雨
     * -------------------------------------------------------------- */

    startAmbient(level = 0.5) {
      const c = ready();
      const buf = noise();
      if (!c || !buf || !state.ambient) return;

      if (rainChain) {
        api.setAmbient(level);
        return;
      }

      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const low = c.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 1400;

      const high = c.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = 240;

      const gain = c.createGain();
      gain.gain.value = 0;

      src.connect(low);
      low.connect(high);
      high.connect(gain);
      gain.connect(master);
      src.start();

      rainChain = { src, gain, low };
      api.setAmbient(level);
    },

    /** level 0–1：雨的大小。可以用来跟着剧情情绪走 */
    setAmbient(level) {
      state.rainLevel = Math.max(0, Math.min(1, Number(level) || 0));
      const c = ready();
      if (!c || !rainChain) return;

      const t = c.currentTime;
      const target = state.rainLevel * state.volume * 0.16;
      rainChain.gain.gain.setTargetAtTime(state.enabled ? target : 0, t, 0.8);
      rainChain.low.frequency.setTargetAtTime(900 + state.rainLevel * 1800, t, 0.9);
    },

    stopAmbient() {
      if (!rainChain || !ctx) return;
      try {
        rainChain.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
        const src = rainChain.src;
        window.setTimeout(() => { try { src.stop(); } catch { /* 已停 */ } }, 1600);
      } catch { /* 忽略 */ }
      rainChain = null;
    },

    ambientLevel: () => state.rainLevel,
  };

  /* 采样优先包装：有内置音就播采样，没加载到才走上面的合成实现 */
  const sampleMap = {
    hover: ['hover', 0.35],
    pick: ['pick', 0.55],
    toggle: ['toggle', 0.45],
    begins: ['begins', 0.5],
    settles: ['settles', 0.45],
    unlock: ['unlock', 0.55],
    deny: ['deny', 0.45],
    confirm: ['confirm', 0.5],
    ending: ['ending', 0.6],
    back: ['back', 0.5],
    closePanel: ['closePanel', 0.45],
    select: ['select', 0.5],
    bong: ['bong', 0.5],
    dropped: ['dropped', 0.5],
  };
  for (const [method, [name, vol]] of Object.entries(sampleMap)) {
    const synth = api[method];
    api[method] = function (...args) {
      if (playSample(name, vol)) return;
      return synth.apply(this, args);
    };
  }

  api.pageTurn = () => {
    if (playSample('toggle', 0.4)) return;
    noiseBurst({ dur: 0.09, freq: 2000, q: 0.8, vol: 0.05 });
  };

  api.swap = () => {
    if (playSample('toggle', 0.4)) return;
    blip({ freq: 640, dur: 0.07, type: 'triangle', vol: 0.05 });
    blip({ freq: 860, dur: 0.09, type: 'triangle', vol: 0.04, delay: 0.05 });
  };

  api.wave = () => {
    if (playSample('ending', 0.55)) return;
    blip({ freq: 196, endFreq: 392, dur: 1.2, type: 'sine', vol: 0.06 });
  };

  return api;
}
