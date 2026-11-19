// LiquidChrome — 原生 WebGL 版（React Bits 组件转 ES module）
// 液态金属流体波纹，用作集合浮层的背景

const PIXEL_BUDGET = 2.4e6;
const SIM_CELL = 4;
const SIM_STEP = 1 / 120;

const VERTEX = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0); }`;

const SIM = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uSize;
uniform vec4 uStroke;
uniform vec2 uImpulse;
out vec4 fragColor;
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  return length(p - a - ab * t);
}
void main() {
  vec2 texel = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * texel;
  vec2 state = texture(uState, uv).rg;
  vec2 around =
    texture(uState, uv - vec2(texel.x, 0.0)).rg +
    texture(uState, uv + vec2(texel.x, 0.0)).rg +
    texture(uState, uv - vec2(0.0, texel.y)).rg +
    texture(uState, uv + vec2(0.0, texel.y)).rg - 4.0 * state;
  float next = state.r + (state.r - state.g) * 0.982 + 0.3 * around.r + 0.08 * (around.r - around.g);
  next *= 0.998;
  if (uImpulse.x != 0.0) {
    float d = segment(gl_FragCoord.xy, uStroke.xy, uStroke.zw) / uImpulse.y;
    next += uImpulse.x * exp(-d * d);
  }
  fragColor = vec4(next, state.r, 0.0, 1.0);
}`;

const SLOPE = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uSize;
out vec4 fragColor;
void main() {
  vec2 texel = 1.0 / uSize;
  vec2 uv = gl_FragCoord.xy * texel;
  float left = texture(uState, uv - vec2(texel.x, 0.0)).r;
  float right = texture(uState, uv + vec2(texel.x, 0.0)).r;
  float down = texture(uState, uv - vec2(0.0, texel.y)).r;
  float up = texture(uState, uv + vec2(0.0, texel.y)).r;
  fragColor = vec4((right - left) * 0.5, (up - down) * 0.5, 0.0, 1.0);
}`;

const CHROME = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uUnit;
uniform float uTime;
uniform float uAmplitude;
uniform vec2 uFrequency;
uniform float uDetail;
uniform float uSharpness;
uniform float uDepth;
uniform float uPresence;
uniform vec3 uTint;
uniform vec2 uShift;
uniform float uRoughness;
uniform float uExposure;
uniform float uLight;
uniform sampler2D uSlope;
uniform vec2 uSlopeSize;
uniform float uRipple;
out vec4 fragColor;

vec2 slopeAt(vec2 uv) {
  vec2 st = uv * uSlopeSize - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / uSlopeSize;
  vec2 h1 = (i + 1.5 + w3 / g1) / uSlopeSize;
  vec2 a = texture(uSlope, vec2(h0.x, h0.y)).rg;
  vec2 b = texture(uSlope, vec2(h1.x, h0.y)).rg;
  vec2 c = texture(uSlope, vec2(h0.x, h1.y)).rg;
  vec2 d = texture(uSlope, vec2(h1.x, h1.y)).rg;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

float lamp(vec2 p, vec2 center, vec2 size, float soft) {
  vec2 grown = size + soft;
  vec2 q = (p - center) / grown;
  q *= q;
  float d = sqrt(sqrt(dot(q, q)));
  float edge = soft / min(grown.x, grown.y);
  float shape = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, d)) * (1.0 - 0.45 * d * d);
  return shape * size.x * size.y / (grown.x * grown.y);
}

vec3 studio(vec3 r, float blur) {
  vec2 p = r.xy / max(r.z + 1.0, 0.05);
  p += uShift * smoothstep(0.3, 1.0, length(p));
  float radius = length(p);
  float soft = 0.008 + blur;
  vec2 dir = p / max(radius, 1e-3);
  float key = lamp(p, vec2(-0.25, 0.42), vec2(0.3, 0.12), soft);
  float side = lamp(p, vec2(0.48, 0.12), vec2(0.06, 0.3), soft);
  float ground = lamp(p, vec2(-0.1, -0.55), vec2(0.45, 0.06), soft);
  float rise = smoothstep(-1.0, 1.0, dir.y);
  if (uLight > 0.5) {
    float edge = 0.008 + blur * 0.8;
    float lobe = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(atan(dir.y, dir.x) * 2.0 + 0.9));
    float tone = mix(2.4, 0.95, smoothstep(0.5 - edge, 1.0 + edge, radius));
    tone = mix(tone, 0.02, smoothstep(0.98 - edge, 1.12 + edge, radius));
    tone = mix(tone, mix(0.03, 0.3, lobe) * (0.8 + 0.4 * rise), smoothstep(1.15 - edge, 1.3 + edge, radius));
    float width = 0.035 + edge;
    tone += 2.4 * exp(-pow((radius - 1.4) / width, 2.0)) * min(1.0, 0.06 / width) * (0.6 + 0.4 * rise);
    return vec3(tone) * (1.0 - 0.5 * side) * (1.0 - 0.3 * ground) + 0.8 * key;
  }
  float width = 0.015 + soft * 2.0;
  float rim = exp(-abs(radius - 1.0) / width) * 0.031 / width * (0.8 + smoothstep(-0.5, 0.8, p.y));
  float band = 1.0 - 0.95 * smoothstep(1.04 - soft, 1.12 + soft, radius);
  float wall = smoothstep(1.25, 1.55, radius) * (0.6 + 0.4 * rise);
  float streak = smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(atan(dir.y, dir.x) * 3.0 + 0.6));
  vec3 color = vec3(0.004, 0.004, 0.005) + 0.02 * smoothstep(-0.4, 0.6, p.y);
  color += vec3(1.0, 0.97, 0.94) * key * 4.0 + vec3(0.9, 0.95, 1.0) * side * 3.0 + ground * 1.2;
  color += vec3(1.0, 0.98, 0.95) * rim;
  color *= band;
  return color + vec3(mix(0.45, 1.8, streak)) * wall;
}

vec3 shade(vec2 slope, vec3 v, float blur, vec3 f0) {
  float steep = length(slope);
  slope *= 3.0 * tanh(steep / 3.0) / max(steep, 1e-6);
  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 r = reflect(v, n);
  float facing = clamp(dot(n, -v), 0.0, 1.0);
  return studio(r, blur) * (f0 + (1.0 - f0) * pow(1.0 - facing, 5.0));
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (2.0 * frag - uResolution) / uUnit;
  vec2 p = uv;
  vec2 rowX = vec2(1.0, 0.0);
  vec2 rowY = vec2(0.0, 1.0);
  float amplitude = uAmplitude * uPresence;
  for (float i = 1.0; i < 9.0; i++) {
    if (i > uDetail) break;
    float a = amplitude / i;
    float soften = exp(0.3 - 0.3 * i);
    float argX = i * uFrequency.x * p.y + uTime;
    p.x += a * cos(argX);
    rowX -= a * sin(argX) * i * uFrequency.x * soften * rowY;
    float argY = i * uFrequency.y * p.x + uTime;
    p.y += a * cos(argY);
    rowY -= a * sin(argY) * i * uFrequency.y * soften * rowX;
  }
  float phase = uTime - p.x - p.y;
  vec2 field = -(rowX + rowY);
  float density = max(length(field), 1e-3);
  vec2 across = field / density;
  float k = uSharpness;
  float sn = sin(phase);
  float cs = cos(phase);
  float th = tanh(k * sn);
  float bevel = (1.0 - th * th) / tanh(k);
  float fade = smoothstep(3.0, 9.0, 3.14159 * uUnit / density);
  float weight = uDepth * uPresence * fade;
  vec2 slope = k * cs * bevel * weight * across + slopeAt(frag / uResolution) * uRipple;
  vec2 sweep = -k * bevel * (sn + 2.0 * k * cs * cs * th) * weight * density * 2.0 / uUnit * across;
  vec2 stepX = dFdx(slope);
  vec2 stepY = dFdy(slope);
  vec2 crease = dot(stepX, stepX) > dot(stepY, stepY) ? stepX : stepY;
  if (dot(crease, crease) > dot(sweep, sweep)) sweep = crease;
  float bend = length(sweep);
  float alpha = smoothstep(0.0, 0.1, length(slope));
  vec3 f0 = mix(vec3(1.0), uTint, smoothstep(0.05, 0.6, length(slope))) * 0.92;
  vec3 v = normalize(vec3(uv * 0.08, -1.0));
  float blur = uRoughness * 0.35;
  vec3 light;
  if (bend < 0.01) {
    light = shade(slope, v, blur + bend * 0.5, f0);
  } else {
    light = vec3(0.0);
    for (float t = -0.375; t < 0.4; t += 0.25) {
      light += shade(slope + sweep * t, v, blur + bend * 0.15, f0);
    }
    light *= 0.25;
  }
  vec3 color = pow(aces(light * uExposure), vec3(1.0 / 2.2));
  float grain = fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715))));
  color += (grain - 0.5) / 255.0;
  fragColor = vec4(clamp(color, 0.0, 1.0) * alpha, alpha);
}`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const parseColor = (value) => {
  const text = String(value || '').trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) { const f = hex[1].length === 3 ? hex[1].replace(/./g, d => d + d) : hex[1]; return [0, 2, 4].map(i => Math.pow(parseInt(f.slice(i, i + 2), 16) / 255, 2.2)); }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map(c => Math.pow(clamp(parseFloat(c) / 255, 0, 1), 2.2));
  return [1, 1, 1];
};
const compile = (gl, type, src) => { const s = gl.createShader(type); if (!s) return null; gl.shaderSource(s, src); gl.compileShader(s); if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s; console.error(gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; };
const link = (gl, frag) => {
  const v = compile(gl, gl.VERTEX_SHADER, VERTEX), f = compile(gl, gl.FRAGMENT_SHADER, frag), p = v && f ? gl.createProgram() : null;
  if (!v || !f || !p) { if (v) gl.deleteShader(v); if (f) gl.deleteShader(f); return null; }
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p); gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null; }
  const uniforms = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); uniforms[info.name] = gl.getUniformLocation(p, info.name); }
  return { program: p, uniforms };
};

export function initLiquidChrome(container, opts = {}) {
  const s = {
    tint: parseColor(opts.color ?? '#ffffff'),
    speed: Math.max(0, opts.speed ?? 0.2),
    amplitude: clamp(opts.amplitude ?? 0.3, 0, 2),
    frequency: [Math.max(0.1, opts.frequencyX ?? 3), Math.max(0.1, opts.frequencyY ?? 3)],
    detail: clamp(Math.round(opts.detail ?? 4), 1, 8),
    thickness: clamp(opts.thickness ?? 1, 0.25, 4),
    depth: Math.max(0, opts.depth ?? 1),
    roughness: clamp(opts.roughness ?? 0.3, 0, 1),
    exposure: Math.max(0, opts.exposure ?? 1),
    interactive: opts.interactive ?? true,
    rippleStrength: Math.max(0, opts.rippleStrength ?? 1),
    rippleSize: clamp(opts.rippleSize ?? 1, 0.2, 4),
    tilt: Math.max(0, opts.tilt ?? 1),
    intro: opts.intro ?? true,
    light: !!opts.lightMode,
    maxRatio: clamp(opts.maxDevicePixelRatio ?? 2, 0.5, 3),
  };

  const canvas = document.createElement('canvas');
  canvas.className = 'lc-canvas'; canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) { canvas.remove(); return () => {}; }
  const chrome = link(gl, CHROME);
  if (!chrome) { canvas.remove(); return () => {}; }
  const fluid = Boolean(gl.getExtension('EXT_color_buffer_float'));
  const sim = fluid ? link(gl, SIM) : null;
  const slope = fluid ? link(gl, SLOPE) : null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vao = gl.createVertexArray();
  const grid = { width: 1, height: 1 };
  const targets = [];
  let slopeTarget = null, current = 0, unit = 1;
  const pointer = { x: 0, y: 0, inside: false, ready: false, nx: 0, ny: 0 };
  const view = { yaw: 0, pitch: 0, vyaw: 0, vpitch: 0 };
  const strokes = [];
  let time = Math.random() * 40;
  let presence = s.intro && !reduced ? 0 : 1;
  let energy = 0, accumulator = 0, raf = 0, last = 0, visible = true, pageVisible = document.visibilityState !== 'hidden', lost = false;

  const makeTarget = (w, h) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: t, framebuffer: fb };
  };
  const dropTarget = (t) => { if (!t) return; gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer); };

  const resize = () => {
    const rect = container.getBoundingClientRect();
    const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, s.maxRatio, Math.sqrt(PIXEL_BUDGET / (cw * ch)));
    const w = Math.max(1, Math.round(cw * ratio)), h = Math.max(1, Math.round(ch * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    unit = Math.min(w, h);
    if (!fluid || !sim || !slope) return;
    const gw = clamp(Math.round(cw / SIM_CELL), 16, 512), gh = clamp(Math.round(ch / SIM_CELL), 16, 512);
    if (gw === grid.width && gh === grid.height && targets.length) return;
    targets.forEach(dropTarget); targets.length = 0; dropTarget(slopeTarget);
    Object.assign(grid, { width: gw, height: gh });
    targets.push(makeTarget(gw, gh), makeTarget(gw, gh));
    slopeTarget = makeTarget(gw, gh);
  };

  const simulate = (steps) => {
    if (!sim || !slope || !slopeTarget) return;
    gl.useProgram(sim.program);
    gl.viewport(0, 0, grid.width, grid.height);
    gl.uniform2f(sim.uniforms.uSize, grid.width, grid.height);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(sim.uniforms.uState, 0);
    for (let i = 0; i < steps; i++) {
      const stroke = i === 0 ? strokes.shift() : null;
      if (stroke) { gl.uniform4f(sim.uniforms.uStroke, stroke.ax, stroke.ay, stroke.bx, stroke.by); gl.uniform2f(sim.uniforms.uImpulse, stroke.strength, stroke.radius); }
      else gl.uniform2f(sim.uniforms.uImpulse, 0, 1);
      const src = targets[current], dst = targets[1 - current];
      gl.bindTexture(gl.TEXTURE_2D, src.texture); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
      gl.drawArrays(gl.TRIANGLES, 0, 3); current = 1 - current;
    }
    gl.useProgram(slope.program);
    gl.uniform2f(slope.uniforms.uSize, grid.width, grid.height); gl.uniform1i(slope.uniforms.uState, 0);
    gl.bindTexture(gl.TEXTURE_2D, targets[current].texture); gl.bindFramebuffer(gl.FRAMEBUFFER, slopeTarget.framebuffer);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const render = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const u = chrome.uniforms;
    gl.useProgram(chrome.program);
    gl.uniform2f(u.uResolution, canvas.width, canvas.height);
    gl.uniform1f(u.uUnit, unit); gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uAmplitude, s.amplitude);
    gl.uniform2f(u.uFrequency, s.frequency[0], s.frequency[1]);
    gl.uniform1f(u.uDepth, s.depth); gl.uniform1f(u.uDetail, s.detail);
    gl.uniform1f(u.uSharpness, 5 / (3 * s.thickness));
    gl.uniform1f(u.uPresence, 1 - Math.pow(1 - presence, 3));
    gl.uniform3fv(u.uTint, s.tint);
    gl.uniform2f(u.uShift, view.yaw, view.pitch);
    gl.uniform1f(u.uRoughness, s.roughness); gl.uniform1f(u.uExposure, s.exposure);
    gl.uniform1f(u.uLight, s.light ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slopeTarget ? slopeTarget.texture : null);
    gl.uniform1i(u.uSlope, 0);
    gl.uniform2f(u.uSlopeSize, grid.width, grid.height);
    gl.uniform1f(u.uRipple, slopeTarget ? s.rippleStrength * 2.2 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = (now) => {
    raf = 0; if (lost) return;
    const dt = clamp((now - last) / 1000 || 0, 0, 0.05);
    last = Math.max(last, now);
    time += dt * s.speed * (reduced ? 0.25 : 1);
    presence = Math.min(1, presence + dt / 1.8);
    const hovering = s.interactive && pointer.inside;
    const reach = reduced ? 0 : s.tilt;
    const tYaw = (hovering ? pointer.nx * 0.35 : 0.22 * Math.sin(time * 1.3)) * reach;
    const tPitch = (hovering ? -pointer.ny * 0.28 : 0.16 * Math.sin(time * 0.9 + 1.7)) * reach;
    const stiff = 36, damp = 2 * Math.sqrt(stiff) * 0.95;
    view.vyaw += ((tYaw - view.yaw) * stiff - view.vyaw * damp) * dt;
    view.vpitch += ((tPitch - view.pitch) * stiff - view.vpitch * damp) * dt;
    view.yaw += view.vyaw * dt; view.pitch += view.vpitch * dt;
    gl.bindVertexArray(vao);
    if (slopeTarget) {
      accumulator += dt;
      const steps = Math.min(4, Math.floor(accumulator / SIM_STEP));
      accumulator -= steps * SIM_STEP;
      if (steps > 0) { simulate(steps); energy = Math.max(0, energy * Math.pow(0.982, steps)); }
    }
    render();
    const settling = Math.abs(view.vyaw) + Math.abs(view.vpitch) > 1e-4 || Math.abs(tYaw - view.yaw) + Math.abs(tPitch - view.pitch) > 1e-4;
    const busy = s.speed > 0 || presence < 1 || settling || energy > 0.002 || strokes.length > 0;
    if (busy && visible && pageVisible) raf = requestAnimationFrame(frame);
  };

  const wake = () => { if (raf || lost || !visible || !pageVisible) return; last = performance.now(); raf = requestAnimationFrame(frame); };
  const toGrid = (cx, cy) => {
    const r = container.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * grid.width, y: (1 - (cy - r.top) / r.height) * grid.height, nx: ((cx - r.left) / r.width) * 2 - 1, ny: ((cy - r.top) / r.height) * 2 - 1, inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom };
  };
  const push = (stroke) => { if (!slopeTarget || !s.interactive || reduced) return; strokes.push(stroke); if (strokes.length > 6) strokes.shift(); energy = 1; };
  const onMove = (e) => { const spot = toGrid(e.clientX, e.clientY); pointer.nx = clamp(spot.nx, -1, 1); pointer.ny = clamp(spot.ny, -1, 1); pointer.inside = spot.inside; if (spot.inside && pointer.ready) { const t = Math.hypot(spot.x - pointer.x, spot.y - pointer.y); if (t > 0.25) push({ ax: pointer.x, ay: pointer.y, bx: spot.x, by: spot.y, strength: -Math.min(0.45, 0.04 + t * 0.045) * s.rippleSize, radius: 4 * s.rippleSize }); } pointer.x = spot.x; pointer.y = spot.y; pointer.ready = spot.inside; wake(); };
  const onDown = (e) => { const spot = toGrid(e.clientX, e.clientY); if (!spot.inside) return; push({ ax: spot.x, ay: spot.y, bx: spot.x, by: spot.y, strength: -1.6 * s.rippleSize, radius: 6 * s.rippleSize }); wake(); };
  const onLeave = () => { pointer.inside = false; pointer.ready = false; wake(); };
  const onUp = (e) => { if (e.pointerType !== 'mouse') onLeave(); };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  const onLost = (e) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => { lost = false; resize(); wake(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const ro = new ResizeObserver(() => { resize(); render(); wake(); }); ro.observe(container);
  const io = new IntersectionObserver((es) => { visible = es.some(e => e.isIntersecting); wake(); }); io.observe(container);
  const onVis = () => { pageVisible = document.visibilityState !== 'hidden'; wake(); };
  document.addEventListener('visibilitychange', onVis);
  resize(); wake();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect(); io.disconnect();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    document.removeEventListener('visibilitychange', onVis);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    if (!gl.isContextLost()) {
      targets.forEach(dropTarget); dropTarget(slopeTarget);
      gl.deleteVertexArray(vao); gl.deleteProgram(chrome.program);
      if (sim) gl.deleteProgram(sim.program); if (slope) gl.deleteProgram(slope.program);
    }
    canvas.remove();
  };
}
