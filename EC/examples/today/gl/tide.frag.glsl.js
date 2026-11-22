// Tide dial fragment shader (WebGL2 / GLSL ES 3.00).
// One fullscreen quad; the disc lives at uCenter with radius uRadius in px.
// Disc space p: radius 1, y up, 0:00 at (0,1), angles run clockwise.
export const TIDE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform vec2  uCenter;      // px, GL y-up
uniform float uRadius;
uniform float uLevel;       // fill fraction 0..1
uniform float uWaveAmp;     // wave amplitude in disc units
uniform vec2  uTilt;        // pointer-driven slosh
uniform vec2  uLight;       // pointer position in disc space
uniform vec3  uColorLow;    // liquid tint near the surface
uniform vec3  uColorHigh;   // liquid tint in the depth
uniform float uDark;        // 0 light .. 1 dark
uniform float uReveal;      // boot materialize 0..1
uniform float uSurge;       // HIGH TIDE act 0..1
uniform float uGlitch;      // entry glitch, decays 0..1
uniform float uPour;        // boot pour stream 0..1
uniform float uFocus;       // focus mode tint 0..1
uniform vec4  uRipples[8];  // x: surface x, y: start time, z: strength
uniform vec2  uPulses[16];  // x: start turn 0..1, y: start time

out vec4 outColor;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; ++i) { v += a * noise(p); p = p * 2.07 + 17.3; a *= 0.5; }
  return v;
}

// Surface height at horizontal position x (disc space), incl. ripples.
float surfaceY(float x) {
  float y = -1.0 + 2.0 * uLevel;
  y -= uTilt.x * x * 0.55;
  float dampEdge = 1.0 - smoothstep(0.72, 1.0, abs(x));
  float w = sin(x * 6.0 + uTime * 1.35) * 0.55
          + sin(x * 11.0 - uTime * 0.95 + fbm(vec2(x * 2.0, uTime * 0.1)) * 2.0) * 0.30
          + sin(x * 17.0 + uTime * 0.6) * 0.15;
  // surge adds a slow heavy swell on top of the ambient waves
  w += uSurge * sin(x * 3.2 - uTime * 0.85) * 0.9;
  y += w * uWaveAmp * dampEdge;
  y += 0.018 * pow(abs(x), 6.0);
  for (int i = 0; i < 8; ++i) {
    float age = uTime - uRipples[i].y;
    if (age > 0.0 && age < 2.6) {
      float d = abs(x - uRipples[i].x);
      float front = d - age * 0.55;
      y += uRipples[i].z * sin(front * 34.0) * exp(-front * front * 60.0)
           * exp(-age * 1.9) * 0.045 * dampEdge;
    }
  }
  return y;
}

vec3 skyAt(vec2 q) {
  vec3 skyTop    = mix(vec3(0.988, 0.992, 0.996), vec3(0.030, 0.050, 0.100), uDark);
  vec3 skyBottom = mix(vec3(0.930, 0.948, 0.972), vec3(0.012, 0.026, 0.060), uDark);
  // surge drags the sky down into deep-sea navy
  vec3 navyTop    = mix(vec3(0.10, 0.16, 0.30), vec3(0.012, 0.022, 0.052), uDark);
  vec3 navyBottom = mix(vec3(0.05, 0.09, 0.19), vec3(0.004, 0.010, 0.026), uDark);
  skyTop = mix(skyTop, navyTop, uSurge);
  skyBottom = mix(skyBottom, navyBottom, uSurge);
  vec3 c = mix(skyBottom, skyTop, smoothstep(-1.0, 1.0, q.y * 0.8 + 0.25));
  c += (fbm(q * 3.0 + 4.0) - 0.5) * 0.018;
  c += vec3(0.05, 0.055, 0.06) * exp(-dot(q - vec2(-0.34, 0.42), q - vec2(-0.34, 0.42)) * 2.6);
  return c;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x - uCenter.x, gl_FragCoord.y - uCenter.y) / uRadius;

  // entry glitch: horizontal band tearing + a little jitter
  if (uGlitch > 0.001) {
    float row = floor(p.y * 34.0);
    float tick = floor(uTime * 30.0);
    float on = step(1.0 - uGlitch * 0.6, hash(vec2(row, tick)));
    p.x += (hash(vec2(row, tick + 7.0)) - 0.5) * 0.14 * uGlitch * on;
    p.x += (hash(vec2(tick, 3.0)) - 0.5) * 0.02 * uGlitch;
  }

  float r = length(p);
  float t = uTime;

  // convex glass: barrel magnification toward the centre; refraction ramps
  // in as the disc materialises so the boot reads as glass forming
  vec2 q = p * (1.0 + 0.16 * r * r * uReveal);

  vec3 col = skyAt(q);

  // glass interior ambient: the empty part of the glass must read lighter
  // than the liquid body, even in the dark theme
  col += mix(vec3(0.030, 0.036, 0.044), vec3(0.055, 0.075, 0.105), uDark)
       * (0.45 + 0.55 * q.y);

  // refracted HUD hairlines: a faint page grid drawn in glass space so the
  // convex lens visibly bends it
  float gridX = 1.0 - smoothstep(0.0, 0.014, abs(fract(q.x * 6.0 + 0.5) - 0.5));
  float gridY = 1.0 - smoothstep(0.0, 0.014, abs(fract(q.y * 6.0 + 0.5) - 0.5));
  float axisX = 1.0 - smoothstep(0.0, 0.008, abs(fract(q.x * 1.5 + 0.5) - 0.5));
  float axisY = 1.0 - smoothstep(0.0, 0.008, abs(fract(q.y * 1.5 + 0.5) - 0.5));
  float grid = gridX + gridY + (axisX + axisY) * 0.5;
  vec3 gridCol = mix(vec3(0.28, 0.38, 0.56), vec3(0.40, 0.50, 0.72), uDark);
  col = mix(col, gridCol, clamp(grid, 0.0, 1.0) * 0.17 * uReveal * (1.0 - uSurge * 0.35));

  // gentle vertical sheen so the empty glass never reads as a flat disc
  float inside = 1.0 - smoothstep(0.95, 1.02, r);
  col += vec3(0.05, 0.06, 0.08) * smoothstep(-0.2, 0.9, q.y) * inside * 0.5;
  col *= 1.0 - smoothstep(-0.9, 0.4, -q.y) * 0.05 * inside;
  // while the disc materialises keep the interior slightly cool so the
  // forming glass separates from the page
  col = mix(col * vec3(0.94, 0.96, 1.0), col, inside * 0.4 + uReveal * 0.6);

  // chromatic fringe of the sky through the rim, evaluated cheaply —
  // compare against the raw sky, not the accumulated colour
  vec3 sky0 = col;
  vec3 colR = skyAt(q * 1.006);
  vec3 colB = skyAt(q * 0.994);

  // ── liquid body ─────────────────────────────────────────────────
  float surf = surfaceY(q.x);
  float depth = surf - q.y;
  float liqMask = smoothstep(-0.004, 0.004, depth) * (1.0 - smoothstep(0.96, 1.02, length(q)));
  // surge liquid is lit coral/amber from within so it separates from navy
  vec3 deep = mix(uColorHigh, vec3(0.16, 0.05, 0.09), uSurge * 0.80);
  vec3 shallow = mix(uColorLow, vec3(1.0, 0.56, 0.36), uSurge * 0.72);
  if (depth > 0.0) {
    float depthN = clamp(depth / 1.4, 0.0, 1.0);
    vec3 liq = mix(shallow, deep, smoothstep(0.0, 0.85, depthN));
    float ca = fbm(q * vec2(4.4, 3.4) + vec2(t * 0.12, -t * 0.18));
    liq += (ca - 0.5) * 0.11 * (1.0 - depthN * 0.7) * (0.5 + uWaveAmp * 10.0);
    liq += vec3(1.0, 0.45, 0.22) * (ca * 0.30 + 0.16) * uSurge * (1.0 - depthN * 0.6);
    float bubbleCount = 3.0 + floor(uWaveAmp * 160.0) + floor(uSurge * 5.0);
    for (int i = 0; i < 16; ++i) {
      float bi = float(i);
      if (bi >= bubbleCount) break;
      float h1 = hash(vec2(bi, 7.7)), h2 = hash(vec2(bi, 3.1));
      float speed = 0.05 + h2 * 0.06 + uSurge * 0.05;
      float bx = -0.75 + 1.5 * h1 + sin(t * 0.7 + bi * 3.0) * 0.02;
      float cycle = fract(t * speed + h1 * 9.0);
      float by = -0.95 + cycle * (surf + 0.9);
      if (by < surf - 0.04 && by > -1.0) {
        float br = 0.006 + h2 * 0.012;
        float bd = length(q - vec2(bx, by));
        float ring = (1.0 - smoothstep(br * 0.55, br, bd)) * (0.55 + 0.45 * cycle);
        liq += ring * mix(0.25, 0.6, uDark) * (1.0 - depthN * 0.4);
      }
    }
    for (int i = 0; i < 8; ++i) {
      float age = t - uRipples[i].y;
      if (age > 0.0 && age < 2.2) {
        vec2 o = vec2(uRipples[i].x, surf);
        float d = length(q - o);
        float ring = exp(-pow(d - age * 0.5, 2.0) * 220.0) * exp(-age * 2.0) * uRipples[i].z;
        liq += ring * mix(0.35, 0.8, uDark) * step(depth, d + 0.2);
      }
    }
    liq += liq * uDark * (0.35 + 0.25 * ca);
    liq = mix(liq, vec3(0.30, 0.46, 0.95), uFocus * 0.45);
    float liqA = mix(0.88, 0.92, uDark);
    col = mix(col, liq, liqMask * liqA);
  }

  // ── pour stream during the briefing ─────────────────────────────
  if (uPour > 0.001) {
    // the stream head sinks from the top of the glass down to the surface
    float head = mix(1.25, surf, pow(uPour, 0.7));
    float colw = abs(q.x + 0.02);
    float stream = (1.0 - smoothstep(0.025, 0.10, colw)) * step(head, q.y);
    float flow = fbm(vec2(q.x * 30.0, q.y * 6.0 - t * 3.2));
    float body = stream * (0.45 + 0.55 * flow);
    vec3 streamCol = mix(deep, shallow, 0.25) + 0.08;
    col = mix(col, streamCol, clamp(body, 0.0, 1.0) * 0.95 * min(1.0, uPour * 4.0));
    // splash foam where the stream meets the surface
    float splash = exp(-pow((q.y - surf) * 9.0, 2.0)) * (1.0 - smoothstep(0.03, 0.09, colw)) * uPour;
    col += splash * vec3(0.5, 0.6, 0.7) * 1.0;
  }

  // ── surface: bright meniscus + foam crest + surge spray ─────────
  float mLine = exp(-abs(depth) * 150.0) * (1.0 - smoothstep(0.9, 1.05, length(q)));
  vec3 foam = mix(vec3(1.0), shallow * 1.4 + 0.4, uDark * 0.5);
  col += mLine * foam * (0.55 + 0.25 * uDark + uSurge * 0.35);
  // bright crest line hugging the surface
  float crest = exp(-pow((depth + 0.010) * 80.0, 2.0)) * (1.0 - smoothstep(0.92, 1.04, length(q)));
  col += crest * mix(vec3(0.85, 0.92, 1.0), vec3(1.0, 0.85, 0.65), uSurge * 0.75) * (0.45 + 0.35 * uSurge);
  // surge foam: noisy crest along the surface
  if (uSurge > 0.01 && depth > -0.05 && depth < 0.02) {
    float f = fbm(vec2(q.x * 14.0, t * 0.7)) * smoothstep(0.02, -0.01, depth);
    col += vec3(0.95, 0.75, 0.55) * f * uSurge * 0.55;
  }
  // surge spray: droplets tossed just above the surface
  if (uSurge > 0.01) {
    for (int i = 0; i < 10; ++i) {
      float di = float(i);
      float dh1 = hash(vec2(di, 11.0)), dh2 = hash(vec2(di, 5.0));
      float cyc = fract(t * (0.5 + dh1 * 0.7) + dh2 * 9.0);
      float dx = -0.8 + 1.6 * dh1;
      float dy = surfaceY(dx) + cyc * 0.4;
      float dd = length(q - vec2(dx, dy));
      float dr = 0.010 * (1.0 - cyc * 0.5);
      col += (1.0 - smoothstep(dr * 0.5, dr, dd)) * vec3(1.0, 0.85, 0.72) * uSurge * (1.0 - cyc) * 0.55;
    }
  }

  // ── glass ───────────────────────────────────────────────────────
  float fresnel = pow(clamp(r, 0.0, 1.0), 7.0);
  col += fresnel * mix(0.16, 0.30, uDark);
  col *= 1.0 - smoothstep(0.86, 0.995, r) * 0.16; // inner rim shadow
  // diagonal specular streak, top-left, follows the pointer
  vec2 rp = mat2(0.866, -0.5, 0.5, 0.866) * (p - uLight);
  col += exp(-(rp.x * rp.x * 1.1 + rp.y * rp.y * 9.0) * 3.0) * mix(0.42, 0.22, uDark);
  vec2 sp2 = p - vec2(0.38, -0.55);
  col += exp(-dot(sp2, sp2) * 9.0) * mix(0.12, 0.06, uDark);
  // bevel: refracted brightness ring just inside the rim
  float bev = smoothstep(0.93, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r));
  col += bev * vec3(0.10, 0.12, 0.14) * (0.6 + 0.4 * q.y);
  col -= bev * vec3(0.10, 0.10, 0.10) * (0.5 - 0.5 * q.y); // darker under-bevel
  // crisp bright outer edge — the glass thickness reads as a lit ring;
  // it draws on first while the disc materialises, then settles
  float edgeLine = smoothstep(0.968, 0.990, r) * (1.0 - smoothstep(0.990, 1.0, r));
  col += edgeLine * mix(vec3(0.55, 0.62, 0.72), vec3(0.75, 0.82, 0.95), uDark) * (0.55 + 0.45 * uReveal);
  // dispersion: off-axis sky delta only — comparing against the accumulated
  // colour would subtract rim lighting from R and B and cast the band green
  float frg = smoothstep(0.80, 0.99, r) * (1.0 - smoothstep(0.99, 1.0, r));
  vec3 fringe = vec3(colR.r - sky0.r, 0.0, colB.b - sky0.b);
  col += fringe * frg * 1.5 * (1.0 - uDark * 0.4);

  // ── rim pulses: light packets travelling both ways ──────────────
  float turn = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
  float rimBand = smoothstep(0.70, 0.90, r) * (1.0 - smoothstep(0.96, 1.0, r));
  float pulseGlow = 0.0;
  for (int i = 0; i < 16; ++i) {
    float age = t - uPulses[i].y;
    if (age >= 0.0 && age < 2.4) {
      float f1 = fract(uPulses[i].x + age * 0.30);
      float f2 = fract(uPulses[i].x - age * 0.30);
      float d1 = abs(fract(turn - f1 + 0.5) - 0.5);
      float d2 = abs(fract(turn - f2 + 0.5) - 0.5);
      float life = smoothstep(0.0, 0.05, age) * exp(-age * 1.9);
      pulseGlow += (exp(-d1 * d1 * 2600.0) + exp(-d2 * d2 * 2600.0)) * life;
      float d0 = abs(fract(turn - uPulses[i].x + 0.5) - 0.5);
      pulseGlow += exp(-d0 * d0 * 900.0) * exp(-age * 9.0) * 0.8;
    }
  }
  pulseGlow = min(pulseGlow, 1.6);
  col += rimBand * pulseGlow * mix(uColorLow + 0.35, vec3(1.0), 0.4);

  // ── surge: crisp lit coral edge + tight spray haze ──────────────
  float breath = 0.5 + 0.5 * sin(t * 1.5707963);
  float focusCalm = 1.0 - uFocus * 0.65; // focus turns the halo down
  float coral = smoothstep(0.90, 0.98, r) * (1.0 - smoothstep(0.985, 1.03, r))
              * (0.45 + 0.55 * breath) * uSurge * focusCalm;
  col += coral * vec3(0.96, 0.42, 0.34) * 0.85;
  float haze = smoothstep(0.5, 0.9, fbm(p * 5.0 + t * 0.15)) * smoothstep(0.88, 1.02, r)
             * (1.0 - smoothstep(1.02, 1.15, r)) * uSurge * focusCalm;
  col += haze * vec3(0.68, 0.85, 0.94) * 0.18;

  // ── edge, contact shadow and alpha ──────────────────────────────
  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  // soft contact shadow: offset ellipse beneath the disc
  vec2 sh = vec2(p.x, p.y + 1.28);
  float contact = exp(-dot(sh * vec2(1.15, 2.6), sh * vec2(1.15, 2.6)) * 3.2);
  float spill = (coral * 0.5 + rimBand * pulseGlow * 0.5 + haze * 0.55) * (1.0 - edge);
  float alpha = edge * uReveal + spill * uReveal;
  vec3 outsideCol = vec3(0.05, 0.07, 0.12) * contact * mix(0.25, 0.55, uDark);
  col += (1.0 - uReveal) * edge * 0.22;
  // glitch: channel split on the final colour
  if (uGlitch > 0.001) {
    col.r += uGlitch * 0.08 * sin(p.y * 60.0 + t * 40.0);
    col.b -= uGlitch * 0.08 * sin(p.y * 60.0 + t * 40.0);
  }
  outColor = vec4(mix(col, outsideCol, (1.0 - edge) * contact), alpha + (1.0 - edge) * contact * 0.35);
}
`;

export const TIDE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;
