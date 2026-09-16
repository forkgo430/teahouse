/**
 * 氛围层 —— 单块全屏 Canvas，分层绘制。
 *
 * 层次（从后到前）：
 *   光斑   预渲染的柔光，随鼠标轻微视差移动，缓慢呼吸
 *   远雨   细、慢、极淡，给纵深
 *   中雨   主体
 *   近雨   粗、快、亮，制造"在眼前"的感觉
 *   浮尘   缓慢上漂的光点
 *   闪电   低概率的整屏微亮，只一闪
 *
 * 设计取舍：
 *   · 单 canvas 而不是多层 DOM —— 合成一次完成，重绘成本可控。
 *   · 柔光预渲染成离屏 sprite —— 每帧建 radialGradient 会直接拖垮帧率。
 *   · 强度可调 —— 雨势能跟着剧情情绪走，不只是背景板。
 */

const PRESETS = {
  full: { far: 90, mid: 62, near: 30, dust: 38, glow: 3 },
  // 帧率不够时降级，先砍看不见的那部分
  lite: { far: 40, mid: 26, near: 12, dust: 14, glow: 2 },
};

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 柔光 sprite：一次画好，之后只管贴 */
function makeGlowSprite(size, inner, outer) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;

  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.45, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function createAtmosphere(canvas, options = {}) {
  const ctx = canvas?.getContext?.('2d', { alpha: true });
  if (!ctx) return { start() {}, stop() {}, setIntensity() {}, pulse() {} };

  let w = 0;
  let h = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let preset = PRESETS.full;
  let raf = 0;
  let last = 0;
  let running = false;

  let intensity = options.intensity ?? 0.5;
  let flash = 0;
  let parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const pointer = { x: -9999, y: -9999, active: false };

  let rainFar = [];
  let rainMid = [];
  let rainNear = [];
  let dust = [];
  let glows = [];

  const glowSprites = [
    makeGlowSprite(320, 'rgba(140,185,245,0.28)', 'rgba(140,185,245,0.06)'),
    makeGlowSprite(360, 'rgba(120,200,235,0.22)', 'rgba(120,200,235,0.05)'),
    makeGlowSprite(300, 'rgba(150,170,245,0.18)', 'rgba(150,170,245,0.04)'),
  ];

  /* ---------------------------------------------------------------- *
   * 粒子
   * ---------------------------------------------------------------- */

  const rand = (a, b) => a + Math.random() * (b - a);

  function makeDrop(layer, initial) {
    const spec = {
      far: { len: [6, 16], speed: [40, 90], alpha: [0.045, 0.11], width: 1, drift: [-0.06, -0.14] },
      mid: { len: [12, 30], speed: [120, 220], alpha: [0.07, 0.17], width: 1, drift: [-0.1, -0.24] },
      near: { len: [26, 64], speed: [280, 460], alpha: [0.1, 0.24], width: 2, drift: [-0.16, -0.38] },
    }[layer];

    return {
      x: rand(-40, w + 40),
      y: initial ? rand(-h, h) : rand(-140, -20),
      len: rand(...spec.len),
      speed: rand(...spec.speed),
      alpha: rand(...spec.alpha),
      width: spec.width,
      drift: rand(...spec.drift),
      // 每条雨自己的相位，避免整齐划一像梳子
      sway: rand(0, Math.PI * 2),
    };
  }

  function makeDust(initial) {
    return {
      x: rand(0, w),
      y: initial ? rand(0, h) : rand(h * 0.6, h + 40),
      r: rand(0.6, 2.2),
      vy: rand(-14, -34),
      drift: rand(-10, 10),
      alpha: rand(0.05, 0.2),
      phase: rand(0, Math.PI * 2),
    };
  }

  function makeGlow(index) {
    return {
      index,
      x: rand(0.1, 0.9) * w,
      y: rand(0.05, 0.6) * h,
      r: rand(220, 420),
      vy: rand(-6, 6),
      vx: rand(-8, 8),
      phase: rand(0, Math.PI * 2),
      speed: rand(0.08, 0.22),
      alpha: rand(0.5, 1),
    };
  }

  function respawn() {
    rainFar = Array.from({ length: preset.far }, () => makeDrop('far', true));
    rainMid = Array.from({ length: preset.mid }, () => makeDrop('mid', true));
    rainNear = Array.from({ length: preset.near }, () => makeDrop('near', true));
    dust = Array.from({ length: preset.dust }, () => makeDust(true));
    glows = Array.from({ length: preset.glow }, (_, i) => makeGlow(i));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(rect.width || window.innerWidth));
    h = Math.max(1, Math.round(rect.height || window.innerHeight));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    respawn();
  }

  /* ---------------------------------------------------------------- *
   * 绘制
   * ---------------------------------------------------------------- */

  function drawGlows(t) {
    ctx.globalCompositeOperation = 'lighter';
    for (const g of glows) {
      const breathe = 0.62 + 0.38 * Math.sin(t * g.speed + g.phase);
      const r = g.r * (0.86 + 0.18 * breathe);
      const sprite = glowSprites[g.index % glowSprites.length];
      ctx.globalAlpha = g.alpha * breathe * 0.9;
      ctx.drawImage(
        sprite,
        g.x - r / 2 + parallax.x * 26,
        g.y - r / 2 + parallax.y * 18,
        r,
        r,
      );
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawDust(t) {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of dust) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 1.4 + p.phase);
      ctx.globalAlpha = p.alpha * twinkle;
      ctx.beginPath();
      ctx.arc(p.x + parallax.x * 14, p.y + parallax.y * 10, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(150, 185, 230, 1)';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function step(list, dt, layer) {
    const speedScale = 0.55 + intensity * 0.9;
    const R = 130;
    const R2 = R * R;

    for (const d of list) {
      d.y += d.speed * speedScale * dt;

      // 鼠标斥力：雨丝靠近光标时被推开一点，像是真的绕过去
      if (pointer.active) {
        const dx = d.x - pointer.x;
        const dy = d.y - pointer.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < R2 && dist2 > 1) {
          const dist = Math.sqrt(dist2);
          const push = (1 - dist / R) * 46 * dt;
          d.x += (dx / dist) * push;
          d.y += (dy / dist) * push * 0.35;
        }
      }

      d.x += d.drift * dt * 22;

      if (d.y > h + 60) Object.assign(d, makeDrop(layer, false));
      if (d.x < -80) d.x = w + 60;
      if (d.x > w + 80) d.x = -60;
    }
  }

  function frame(now) {
    if (!running) return;

    const t = now / 1000;
    const dt = Math.min((now - last) / 1000 || 0.016, 0.05);
    last = now;

    parallax.x += (parallax.tx - parallax.x) * 0.045;
    parallax.y += (parallax.ty - parallax.y) * 0.045;

    ctx.clearRect(0, 0, w, h);

    drawGlows(t);

    step(rainFar, dt, 'far');
    ctx.beginPath();
    for (const d of rainFar) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.drift * 3, d.y + d.len);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(96, 134, 180, ${0.06 + intensity * 0.06})`;
    ctx.stroke();

    step(rainMid, dt, 'mid');
    ctx.beginPath();
    for (const d of rainMid) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.drift * 3, d.y + d.len);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(106, 144, 190, ${0.09 + intensity * 0.09})`;
    ctx.stroke();

    step(rainNear, dt, 'near');
    ctx.beginPath();
    for (const d of rainNear) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.drift * 3.6, d.y + d.len);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(120, 156, 200, ${0.1 + intensity * 0.12})`;
    ctx.stroke();

    step(dust, dt, 'dust');
    for (const p of dust) {
      p.y += p.vy * dt;
      p.x += p.drift * dt;
      if (p.y < -20) Object.assign(p, makeDust(false));
    }
    drawDust(t);

    for (const g of glows) {
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      if (g.x < -40 || g.x > w + 40) g.vx *= -1;
      if (g.y < -40 || g.y > h * 0.8) g.vy *= -1;
    }

    // 闪电：一闪而过，不留痕
    if (flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(110, 145, 190, ${flash * 0.16})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      flash = Math.max(0, flash - dt * 3.2);
    }

    raf = window.requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- *
   * 控制
   * ---------------------------------------------------------------- */

  function onResize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    resize();
  }

  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
    parallax.tx = (e.clientX / Math.max(1, w) - 0.5) * 2;
    parallax.ty = (e.clientY / Math.max(1, h) - 0.5) * 2;
  }

  function onPointerLeave() {
    pointer.active = false;
    parallax.tx = 0;
    parallax.ty = 0;
  }

  function onVisibility() {
    if (document.hidden) {
      stop();
    } else if (!reducedMotion()) {
      start();
    }
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    window.cancelAnimationFrame(raf);
  }

  // 低配 / 降级：先按设备能力选预设，跑一会儿若掉帧再降
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) {
    preset = PRESETS.lite;
  }

  resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);

  if (!reducedMotion()) start();

  return {
    start,
    stop,
    /** 0–1：雨势。跟着剧情情绪走 */
    setIntensity(v) {
      const next = Math.max(0, Math.min(1, Number(v) || 0));
      // 变密时把不足的粒子补上，避免只变速度不变密度
      if (next > intensity + 0.2 && preset === PRESETS.full) {
        intensity = next;
        respawn();
        return;
      }
      intensity = next;
    },
    intensity: () => intensity,
    /** 闪电：一下 */
    pulse() { flash = 1; },
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
