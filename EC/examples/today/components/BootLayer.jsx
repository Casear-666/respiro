// Boot overlay for the ~5.5s briefing: terminal lines typed with clicks,
// an original circle+wave mark drawn by stroke, then a scan line sweep.
// Everything is keyed off bootT seconds; nothing here depends on audio.

const LINES = [
  { at: 0.0, text: "ENERGY CALENDAR · TIDE OBSERVATORY" },
  { at: 0.34, text: "> 同步今日日程 ……… {COUNT} 项" },
  { at: 0.62, text: "> 计算潮位 ……… {LOAD}" },
  { at: 0.9, text: "> 校准表盘 ……… OK" },
];

export function BootLayer({ bootT, count, load }) {
  if (bootT == null) return null;
  const charsPer = 38; // cps
  const markP = Math.min(1, Math.max(0, (bootT - 1.2) / 0.9));
  const scanP = Math.min(1, Math.max(0, (bootT - 1.7) / 0.55));
  const fade = bootT > 2.2 ? Math.max(0, 1 - (bootT - 2.2) / 0.35) : 1;
  if (fade <= 0 && bootT > 2.4) return null;

  const text = (tpl) =>
    tpl.replace("{COUNT}", String(count)).replace("{LOAD}", load.toFixed(2));
  return (
    <div className="boot-layer" style={{ opacity: fade }}>
      <div className="boot-term mono">
        {LINES.map((line, i) => {
          const t = text(line.text);
          const n = Math.max(0, Math.min(t.length, Math.floor((bootT - line.at) * charsPer)));
          if (n <= 0) return <p key={i} className="boot-line" />;
          return (
            <p key={i} className="boot-line">
              {t.slice(0, n)}
              {bootT - line.at < t.length / charsPer + 0.25 && <span className="caret" />}
            </p>
          );
        })}
      </div>
      {markP > 0 && (
        <svg className="boot-mark" viewBox="0 0 120 120" aria-hidden="true">
          <circle
            cx="60" cy="60" r="44" fill="none" pathLength="1"
            strokeDasharray={`${markP} 1`}
            transform="rotate(-90 60 60)"
          />
          <path
            d="M 30 62 Q 45 52 60 62 T 90 62"
            fill="none" pathLength="1"
            strokeDasharray={`${Math.max(0, markP * 1.6 - 0.6)} 1`}
          />
          <circle cx="60" cy="60" r="3.2" className="boot-mark-dot"
            style={{ opacity: markP > 0.85 ? 1 : 0 }} />
        </svg>
      )}
      {scanP > 0 && scanP < 1 && (
        <div className="boot-scan" style={{ top: `${scanP * 100}%` }} />
      )}
    </div>
  );
}
