// Rolling text: digits roll upward through a column like RhineLabUI's
// rolling numbers (~460ms, blur mid-motion); other glyphs fade/swap.
import { useEffect, useRef, useState } from "react";

const ROWS = 30; // three wraps of 0-9; offset is normalized into the middle wrap

function RollDigit({ char, duration, delay = 0 }) {
  const [offset, setOffset] = useState(() => 10 + (char.charCodeAt(0) - 48));
  const [moving, setMoving] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    const digit = char.charCodeAt(0) - 48;
    if (!(digit >= 0 && digit <= 9)) return;
    setOffset((current) => {
      // Always roll upward; each step of a digit crosses that many rows.
      const diff = (digit - (((current % 10) + 10) % 10) + 10) % 10;
      if (diff === 0) return current;
      setMoving(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMoving(false), duration + delay + 40);
      return current + diff;
    });
  }, [char, duration, delay]);
  // Once the motion rests, jump back into the middle wrap (invisible — the
  // rows are identical mod 10) so the offset never leaves the strip.
  const normalize = () => {
    setInstant(true);
    setOffset((o) => 10 + (((o % 10) + 10) % 10));
    requestAnimationFrame(() => requestAnimationFrame(() => setInstant(false)));
  };
  return (
    <span className="rc" aria-hidden="true">
      <span
        className="rc-inner"
        data-moving={moving || undefined}
        data-instant={instant || undefined}
        onTransitionEnd={(e) => e.propertyName === "transform" && normalize()}
        style={{
          transform: `translateY(${-offset}em)`,
          transitionDuration: `${duration}ms`,
          transitionDelay: `${delay}ms`,
        }}
      >
        {Array.from({ length: ROWS }, (_, i) => (
          <span key={i} className="rc-row">
            {i % 10}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingText({ text, duration = 460, className = "", delayStep = 0 }) {
  const chars = String(text);
  return (
    <span className={`rolling ${className}`} aria-label={chars} role="text">
      {[...chars].map((ch, i) =>
        ch >= "0" && ch <= "9" ? (
          <RollDigit key={`${i}`} char={ch} duration={duration} delay={i * delayStep} />
        ) : (
          <span key={`${i}-${ch}`} className="rc-static" aria-hidden="true">
            {ch === " " ? " " : ch}
          </span>
        ),
      )}
    </span>
  );
}

// Numeric convenience wrapper with padding.
export function RollingNumber({ value, pad = 0, duration = 460, className = "" }) {
  const text = pad > 0 ? String(Math.round(value)).padStart(pad, "0") : String(value);
  return <RollingText text={text} duration={duration} className={className} />;
}
