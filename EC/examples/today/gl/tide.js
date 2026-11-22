// Raw WebGL2 plumbing for the tide dial: context, program, uniforms, ring
// buffers for ripples/pulses, DPR-aware resize and a visibility-aware loop.
import { TIDE_FRAG, TIDE_VERT } from "./tide.frag.glsl.js";

const UNIFORMS = [
  "uResolution", "uTime", "uCenter", "uRadius", "uLevel", "uWaveAmp",
  "uTilt", "uLight", "uColorLow", "uColorHigh", "uDark", "uReveal",
  "uSurge", "uGlitch", "uPour", "uFocus", "uRipples", "uPulses",
];

export function createTide(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false, // shader outputs straight (unassociated) alpha
    powerPreference: "low-power",
  });
  if (!gl) return null;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("tide shader:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, TIDE_VERT);
  const fs = compile(gl.FRAGMENT_SHADER, TIDE_FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("tide link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const loc = {};
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(prog, name);
  // vec4[] uniforms need the [0] form on some drivers
  loc.uRipples = gl.getUniformLocation(prog, "uRipples[0]") ?? loc.uRipples;
  loc.uPulses = gl.getUniformLocation(prog, "uPulses[0]") ?? loc.uPulses;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied output? -> see below
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const ripples = new Float32Array(8 * 4).fill(-1000);
  const pulses = new Float32Array(16 * 2).fill(-1000);
  let rippleCursor = 0;
  let pulseCursor = 0;

  const api = {
    ok: true,
    gl,
    time: 0,
    frozen: null, // when ?freeze= is used, GL time is pinned
    resize() {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      return dpr;
    },
    // A ripple at horizontal surface position x in disc space (-1..1).
    addRipple(x, strength = 1) {
      const i = (rippleCursor++ % 8) * 4;
      ripples[i] = x;
      ripples[i + 1] = api.time;
      ripples[i + 2] = strength;
    },
    // A light pulse starting at rim turn fraction (0..1, clockwise from top).
    addPulse(turn) {
      const i = (pulseCursor++ % 16) * 2;
      pulses[i] = ((turn % 1) + 1) % 1;
      pulses[i + 1] = api.time;
    },
    // Draw one frame. `u` carries all the springed scalar/vec uniforms.
    frame(dt, u) {
      if (api.frozen == null) api.time += dt;
      const t = api.frozen ?? api.time;
      gl.uniform2f(loc.uResolution, canvas.width, canvas.height);
      gl.uniform1f(loc.uTime, t);
      // uCenter/uRadius come in as CSS px relative to the canvas box
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      gl.uniform2f(
        loc.uCenter,
        u.center[0] * dpr,
        canvas.height - u.center[1] * dpr, // flip to GL y-up
      );
      gl.uniform1f(loc.uRadius, u.radius * dpr);
      gl.uniform1f(loc.uLevel, u.level);
      gl.uniform1f(loc.uWaveAmp, u.waveAmp);
      gl.uniform2f(loc.uTilt, u.tilt[0], u.tilt[1]);
      gl.uniform2f(loc.uLight, u.light[0], u.light[1]);
      gl.uniform3f(loc.uColorLow, ...u.colorLow);
      gl.uniform3f(loc.uColorHigh, ...u.colorHigh);
      gl.uniform1f(loc.uDark, u.dark);
      gl.uniform1f(loc.uReveal, u.reveal);
      gl.uniform1f(loc.uSurge, u.surge);
      gl.uniform1f(loc.uGlitch, u.glitch);
      gl.uniform1f(loc.uPour, u.pour);
      gl.uniform1f(loc.uFocus, u.focus);
      gl.uniform4fv(loc.uRipples, ripples);
      gl.uniform2fv(loc.uPulses, pulses);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  return api;
}
