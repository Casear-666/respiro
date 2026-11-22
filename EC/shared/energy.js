// The calendar's primary color channel always represents workload, never category.
// A blue ramp runs from pale sky to deep indigo as the day gets busier.
const stops = [
  { count: 1, h: 206, s: 80, l: 74, label: "从容" },
  { count: 2, h: 212, s: 78, l: 64, label: "充实" },
  { count: 3, h: 218, s: 76, l: 55, label: "较忙" },
  { count: 5, h: 226, s: 68, l: 46, label: "繁忙" },
  { count: 8, h: 236, s: 56, l: 36, label: "高负荷" },
];
function luminance(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const textLuminance = (rgb) =>
  rgb
    .map((c) => c / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
export function energyForCount(value) {
  const count = Math.max(1, Math.min(8, Number(value) || 1));
  let lower = stops[0],
    upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++)
    if (count >= stops[i].count && count <= stops[i + 1].count) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  const t = (count - lower.count) / (upper.count - lower.count);
  const hueDelta = ((upper.h - lower.h + 540) % 360) - 180;
  const h = (lower.h + hueDelta * t + 360) % 360,
    s = lower.s + (upper.s - lower.s) * t;
  let l = lower.l + (upper.l - lower.l) * t;
  const dark = textLuminance([15, 27, 45]),
    light = textLuminance([255, 255, 255]);
  const minContrast = (textLum) =>
    Math.min(
      contrast(textLum, luminance(h, s, l + 2)),
      contrast(textLum, luminance(h, s, l - 2)),
    );
  const darkText = minContrast(dark) >= minContrast(light);
  // Preserve readable labels across the complete continuous spectrum, in either theme.
  for (let i = 0; i < 30 && minContrast(darkText ? dark : light) < 4.5; i++)
    l += darkText ? 0.5 : -0.5;
  const ink = `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
  return {
    count,
    h,
    s,
    l,
    ink,
    text: darkText ? "#0f1b2d" : "#ffffff",
    contrast: minContrast(darkText ? dark : light),
    gradient: `linear-gradient(180deg, hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${(l + 2).toFixed(1)}%), hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${(l - 2).toFixed(1)}%))`,
    cell: `hsl(${h.toFixed(1)} 90% 60% / ${(0.07 + count * 0.03).toFixed(3)})`,
    label: [...stops].reverse().find((stop) => count >= stop.count).label,
  };
}
export const energyLegend = () =>
  `linear-gradient(90deg, ${stops.map((stop) => energyForCount(stop.count).ink).join(", ")})`;
