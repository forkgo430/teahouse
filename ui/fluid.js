/**
 * 流体背景 —— WebGL2 两遍模拟：1/4 分辨率流场（衰减 + 指针笔刷，双缓冲
 * ping-pong）被全分辨率域扭曲噪声渲染器采样，带 swirl 迭代与三色柔混。
 *
 * 移植自 WYH66666666/DSH-Transparent-UI-Plugin（Aqua 主题，MIT License）的
 * src/client/fluid-shader.ts，后者是 deepseek.com join-section 流体着色器的
 * 忠实移植。着色器源码逐字保留；uniform 接线、30fps 节流、1.5x 像素比上限、
 * 指针监听策略（触屏与 Windows 跳过鼠标馈送）均照搬。
 * reduced-motion 时只渲染一帧静态画面。
 */

/** 站点默认参数（join-section 观感）。 */
export const SITE_FLUID_PARAMS = {
  mouseRadius: 0.22,
  mouseStrength: 1.1,
  decay: 0.96,
  distortBoost: 1.35,
  noiseBoost: 0,
  swirlBoost: 0.45,
  speed: 14,
  distortion: 20,
  swirl: 12,
  swirlIterations: 8,
  scale: 0.5,
  rotation: -5,
  proportion: 50,
  softness: 100,
  shapeScale: 10,
  offsetX: 0,
  offsetY: 65,
  color1: '#8AA3D6',
  color2: '#FFFFFF',
  color3: '#FFFFFF',
};

/** 茶馆配色：DSH 截图同款饱和青蓝（teal），白亮纹流动其间 */
export const TEA_FLUID_PARAMS = {
  ...SITE_FLUID_PARAMS,
  mouseRadius: 0.26,
  mouseStrength: 0.9,
  speed: 11,
  scale: 0.42,
  proportion: 55,
  softness: 92,
  color1: '#2E9FB5',
  color2: '#9FDCE6',
  color3: '#F4FDFE',
};

const VERTEX_SHADER = `#version 300 es
in vec4 a_position;
out vec2 vUv;
void main() {
  vUv = a_position.xy * 0.5 + 0.5;
  gl_Position = a_position;
}
`;

const FLOW_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D u_prev;
uniform vec2 u_mouse;
uniform vec2 u_velocity;
uniform float u_brushRadius;
uniform float u_brushStrength;
uniform float u_decay;
out vec4 fragColor;

void main() {
  vec4 prev = texture(u_prev, vUv);

  prev.r *= u_decay;
  prev.gb = mix(vec2(0.5), prev.gb, u_decay);

  float dist = distance(vUv, u_mouse);

  float influence = exp(-dist * dist / (u_brushRadius * u_brushRadius * 0.5));
  influence = max(0.0, influence - 0.01);

  float speed = length(u_velocity);
  float presenceStrength = u_brushStrength * 0.3;
  float velBonus = min(speed * 3.0, 0.7) * u_brushStrength;
  float totalStrength = presenceStrength + velBonus;

  prev.r = max(prev.r, influence * totalStrength);
  float blendAmt = influence * min(totalStrength, 0.4) * 0.3;
  prev.g = mix(prev.g, clamp(u_velocity.x * 2.0 + 0.5, 0.0, 1.0), blendAmt);
  prev.b = mix(prev.b, clamp(u_velocity.y * 2.0 + 0.5, 0.0, 1.0), blendAmt);

  fragColor = prev;
}
`;

const DISPLAY_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform float u_time;
uniform float u_pixelRatio;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_rotation;
uniform vec4 u_color1, u_color2, u_color3;
uniform float u_colorCount;
uniform float u_proportion;
uniform float u_softness;
uniform float u_shape;
uniform float u_shapeScale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_swirlIterations;
uniform vec2 u_offset;
uniform sampler2D u_flowmap;
uniform float u_distortBoost;
uniform float u_noiseBoost;
uniform float u_swirlBoost;
out vec4 fragColor;

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

vec2 rotate(vec2 uv, float th) { return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv; }
float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123); }
float noise(vec2 st) {
  vec2 i = floor(st); vec2 f = fract(st);
  float a = random(i), b = random(i + vec2(1,0)), c = random(i + vec2(0,1)), d = random(i + vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

vec3 blend_multi(float mixer, float softness) {
  float edge = 1.0 - softness;
  vec3 col = u_color1.rgb;
  if (u_colorCount > 1.5) { col = mix(col, u_color2.rgb, smoothstep(0.0 + 0.35*edge, 0.7 - 0.35*edge, mixer)); }
  if (u_colorCount > 2.5) { col = mix(col, u_color3.rgb, smoothstep(0.3 + 0.35*edge, 1.0 - 0.35*edge, mixer)); }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = .5 * u_time;
  float ns = .0005 + .006 * u_scale;
  uv -= .5; uv *= (ns * u_resolution); uv = rotate(uv, u_rotation * .5 * PI);
  uv /= u_pixelRatio; uv += .5; uv += u_offset;

  vec2 fragUV = gl_FragCoord.xy / u_resolution.xy;
  vec4 flow = texture(u_flowmap, fragUV);
  float influence = flow.r;
  vec2 flowDir = (flow.gb - 0.5) * 2.0;

  float n1 = noise(uv + t), n2 = noise(uv*2. - t);
  float angle = n1 * TWO_PI;

  float totalDistortion = u_distortion + influence * u_distortBoost;
  uv.x += 4. * totalDistortion * n2 * cos(angle);
  uv.y += 4. * totalDistortion * n2 * sin(angle);

  uv += flowDir * influence * 0.15;

  if (influence > 0.001) {
    float localNoise = noise(uv * 2.0 + t * 1.5);
    uv += influence * u_noiseBoost * vec2(cos(localNoise * TWO_PI), sin(localNoise * TWO_PI));
  }

  float iters = ceil(clamp(u_swirlIterations, 1., 30.));
  float swirlAmt = clamp(u_swirl, 0., 2.) + influence * u_swirlBoost;
  for (float i = 1.; i <= 30.0; i++) {
    if (i > iters) break;
    uv.x += swirlAmt / i * cos(t + i*1.5*uv.y);
    uv.y += swirlAmt / i * cos(t + i*1.*uv.x);
  }

  float proportion = clamp(u_proportion, 0., 1.);
  vec2 cuv = uv * (.5 + 3.5 * u_shapeScale);
  float shape = .5 + .5 * sin(cuv.x) * cos(cuv.y);
  float mixer = shape + .48 * sign(proportion - .5) * pow(abs(proportion - .5), .5);
  vec3 col = blend_multi(mixer, clamp(u_softness, 0., 1.));
  fragColor = vec4(col, 1.0);
}
`;

function hexToRgb(value) {
  const hex = value.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/**
 * 在 canvas 上挂载流体模拟并运行直到 dispose。
 * @returns {{ setParams: Function, stir: Function, dispose: Function }}
 */
export function attachFluidShader(canvas, params) {
  const noop = { setParams: () => {}, stir: () => {}, dispose: () => {} };
  const gl = canvas?.getContext?.('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  });
  if (!gl) return noop;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('tea fluid shader:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  };

  const link = (fragment) => {
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const frag = compile(gl.FRAGMENT_SHADER, fragment);
    if (!vertex || !frag) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('tea fluid link:', gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  };

  const flowProgram = link(FLOW_SHADER);
  const displayProgram = link(DISPLAY_SHADER);
  if (!flowProgram || !displayProgram) return noop;

  const flow = {
    prev: gl.getUniformLocation(flowProgram, 'u_prev'),
    mouse: gl.getUniformLocation(flowProgram, 'u_mouse'),
    velocity: gl.getUniformLocation(flowProgram, 'u_velocity'),
    brushRadius: gl.getUniformLocation(flowProgram, 'u_brushRadius'),
    brushStrength: gl.getUniformLocation(flowProgram, 'u_brushStrength'),
    decay: gl.getUniformLocation(flowProgram, 'u_decay'),
  };
  const display = {
    time: gl.getUniformLocation(displayProgram, 'u_time'),
    pixelRatio: gl.getUniformLocation(displayProgram, 'u_pixelRatio'),
    resolution: gl.getUniformLocation(displayProgram, 'u_resolution'),
    scale: gl.getUniformLocation(displayProgram, 'u_scale'),
    rotation: gl.getUniformLocation(displayProgram, 'u_rotation'),
    offset: gl.getUniformLocation(displayProgram, 'u_offset'),
    color1: gl.getUniformLocation(displayProgram, 'u_color1'),
    color2: gl.getUniformLocation(displayProgram, 'u_color2'),
    color3: gl.getUniformLocation(displayProgram, 'u_color3'),
    colorCount: gl.getUniformLocation(displayProgram, 'u_colorCount'),
    proportion: gl.getUniformLocation(displayProgram, 'u_proportion'),
    softness: gl.getUniformLocation(displayProgram, 'u_softness'),
    shape: gl.getUniformLocation(displayProgram, 'u_shape'),
    shapeScale: gl.getUniformLocation(displayProgram, 'u_shapeScale'),
    distortion: gl.getUniformLocation(displayProgram, 'u_distortion'),
    swirl: gl.getUniformLocation(displayProgram, 'u_swirl'),
    swirlIterations: gl.getUniformLocation(displayProgram, 'u_swirlIterations'),
    flowmap: gl.getUniformLocation(displayProgram, 'u_flowmap'),
    distortBoost: gl.getUniformLocation(displayProgram, 'u_distortBoost'),
    noiseBoost: gl.getUniformLocation(displayProgram, 'u_noiseBoost'),
    swirlBoost: gl.getUniformLocation(displayProgram, 'u_swirlBoost'),
  };

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const bindQuad = (program) => {
    const position = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  };

  const makeTarget = (width, height, initial) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (initial !== undefined) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, initial);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  };

  let width = 0;
  let height = 0;
  let flowWidth = 0;
  let flowHeight = 0;
  let flip = false;
  let current = { ...params };
  const pointer = { x: 0.5, y: 0.5, smoothX: 0.5, smoothY: 0.5, vx: 0, vy: 0, svx: 0, svy: 0 };
  const dprCap = Math.min(window.devicePixelRatio || 1, 1.5);
  width = Math.round(canvas.clientWidth * dprCap);
  height = Math.round(canvas.clientHeight * dprCap);
  canvas.width = width;
  canvas.height = height;
  flowWidth = Math.round(width / 4);
  flowHeight = Math.round(height / 4);

  const initial = new Uint8Array(flowWidth * flowHeight * 4);
  for (let i = 0; i < flowWidth * flowHeight; i += 1) {
    initial[4 * i] = 0;
    initial[4 * i + 1] = 128;
    initial[4 * i + 2] = 128;
    initial[4 * i + 3] = 255;
  }
  let targetA = makeTarget(flowWidth, flowHeight, initial);
  let targetB = makeTarget(flowWidth, flowHeight, initial);

  // 站点策略：触屏与 Windows 跳过鼠标馈送
  const coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  const ua = navigator;
  const windows = ua.userAgentData
    ? ua.userAgentData.platform === 'Windows'
    : navigator.userAgent.includes('Windows');
  const onMouseMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = 1 - (event.clientY - rect.top) / rect.height;
  };
  if (!coarse && !windows) window.addEventListener('mousemove', onMouseMove);

  const start = performance.now();
  let raf = 0;
  let previous = 0;
  const step = 1000 / 30;

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (now - previous < step) return;
    previous = now - ((now - previous) % step);

    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextWidth = Math.round(canvas.clientWidth * ratio);
    const nextHeight = Math.round(canvas.clientHeight * ratio);
    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
    }

    const p = current;
    const s = pointer;
    s.svx *= 0.94;
    s.svy *= 0.94;
    s.smoothX += (s.x - s.smoothX) * 0.12;
    s.smoothY += (s.y - s.smoothY) * 0.12;
    s.svx += ((s.x - s.smoothX) * 0.5 - s.svx) * 0.15;
    s.svy += ((s.y - s.smoothY) * 0.5 - s.svy) * 0.15;

    const read = flip ? targetA : targetB;
    const write = flip ? targetB : targetA;
    flip = !flip;

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, flowWidth, flowHeight);
    gl.useProgram(flowProgram);
    bindQuad(flowProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(flow.prev, 0);
    gl.uniform2f(flow.mouse, s.smoothX, s.smoothY);
    gl.uniform2f(flow.velocity, s.svx, s.svy);
    gl.uniform1f(flow.brushRadius, p.mouseRadius);
    gl.uniform1f(flow.brushStrength, p.mouseStrength);
    gl.uniform1f(flow.decay, p.decay);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.viewport(0, 0, width, height);
    gl.useProgram(displayProgram);
    bindQuad(displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, write.tex);
    gl.uniform1i(display.flowmap, 0);
    const time = (performance.now() - start) * 0.001 * (p.speed / 100);
    gl.uniform1f(display.time, time);
    gl.uniform1f(display.pixelRatio, window.devicePixelRatio || 1);
    gl.uniform2f(display.resolution, width, height);
    gl.uniform1f(display.scale, p.scale);
    gl.uniform1f(display.rotation, p.rotation / 90);
    gl.uniform2f(display.offset, p.offsetX / 100, p.offsetY / 100);
    const c1 = hexToRgb(p.color1 || '#2E58A4');
    const c2 = hexToRgb(p.color2 || '#D2E2EE');
    const c3 = hexToRgb(p.color3 || '#FFFFFF');
    gl.uniform4f(display.color1, c1[0], c1[1], c1[2], 1);
    gl.uniform4f(display.color2, c2[0], c2[1], c2[2], 1);
    gl.uniform4f(display.color3, c3[0], c3[1], c3[2], 1);
    gl.uniform1f(display.colorCount, 3);
    gl.uniform1f(display.proportion, p.proportion / 100);
    gl.uniform1f(display.softness, p.softness / 100);
    gl.uniform1f(display.shape, 0);
    gl.uniform1f(display.shapeScale, p.shapeScale / 100);
    gl.uniform1f(display.distortion, p.distortion / 100);
    gl.uniform1f(display.swirl, p.swirl / 50);
    gl.uniform1f(display.swirlIterations, p.swirlIterations);
    gl.uniform1f(display.distortBoost, p.distortBoost);
    gl.uniform1f(display.noiseBoost, p.noiseBoost);
    gl.uniform1f(display.swirlBoost, p.swirlBoost);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const handle = {
    setParams: (next) => {
      current = { ...next };
    },
    stir: (x, y, vx, vy) => {
      pointer.x += (x - pointer.x) * 0.35;
      pointer.y += (y - pointer.y) * 0.35;
      pointer.svx += (vx - pointer.svx) * 0.3;
      pointer.svy += (vy - pointer.svy) * 0.3;
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMouseMove);
    },
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    frame(performance.now());
    cancelAnimationFrame(raf);
    return handle;
  }

  raf = requestAnimationFrame(frame);
  return handle;
}
