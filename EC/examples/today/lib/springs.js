// Minimal critically-/under-damped spring integrators driven by the GL rAF
// loop. Pure JS, no dependency; easy to port later.
export function makeSpring(value = 0, { stiffness = 60, damping } = {}) {
  const zeta = damping ?? 2 * Math.sqrt(stiffness); // critical by default
  return {
    value,
    velocity: 0,
    target: value,
    stiffness,
    damping: zeta,
    step(dt) {
      // Semi-implicit Euler is stable for the dt range rAF produces.
      const k = this.stiffness;
      const c = this.damping;
      const a = (this.target - this.value) * k - this.velocity * c;
      this.velocity += a * dt;
      this.value += this.velocity * dt;
      return this.value;
    },
    get resting() {
      return Math.abs(this.target - this.value) < 1e-4 && Math.abs(this.velocity) < 1e-4;
    },
    snap(v) {
      this.value = this.target = v;
      this.velocity = 0;
    },
  };
}

export function makeSpring2(x = 0, y = 0, opts = {}) {
  const sx = makeSpring(x, opts);
  const sy = makeSpring(y, opts);
  return {
    sx,
    sy,
    set(tx, ty) {
      sx.target = tx;
      sy.target = ty;
    },
    step(dt) {
      sx.step(dt);
      sy.step(dt);
      return [sx.value, sy.value];
    },
  };
}

// Convenience: framerate-independent exponential approach for tiny targets.
export const damp = (current, target, lambda, dt) =>
  target + (current - target) * Math.exp(-lambda * dt);
