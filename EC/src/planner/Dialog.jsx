import { useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "framer-motion";

const GAP = 12,
  EDGE = 16;

/** Place a floating dialog beside an anchor rect, flipping sides when space runs out. */
function place(node, anchor) {
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const w = node.offsetWidth,
    h = node.offsetHeight;
  let left,
    originX = "left";
  if (anchor.right + GAP + w <= vw - EDGE) left = anchor.right + GAP;
  else if (anchor.left - GAP - w >= EDGE) {
    left = anchor.left - GAP - w;
    originX = "right";
  } else left = Math.max(EDGE, Math.min(vw - w - EDGE, anchor.left));
  const top = Math.max(EDGE, Math.min(anchor.top - 24, vh - h - EDGE));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
  node.style.transformOrigin = `${originX} ${Math.round(
    Math.max(0, Math.min(h, anchor.top + anchor.height / 2 - top)),
  )}px`;
}

export default function Dialog({
  children,
  onClose,
  label,
  className = "",
  anchor,
}) {
  const ref = useRef(null),
    previousFocus = useRef(null);
  const anchored = Boolean(anchor) && window.innerWidth > 680;
  useLayoutEffect(() => {
    if (!anchored || !ref.current) return;
    place(ref.current, anchor);
    const onResize = () => ref.current && place(ref.current, anchor);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchored, anchor]);
  useEffect(() => {
    previousFocus.current = document.activeElement;
    const node = ref.current;
    const timer = setTimeout(() => {
      if (node.contains(document.activeElement)) return;
      (
        node.querySelector("[data-autofocus]") ||
        node.querySelector('input:not([type="checkbox"])') ||
        node.querySelector("button")
      )?.focus();
    }, 40);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const focusable = [
          ...node.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"], a[href]',
          ),
        ].filter((el) => el.getClientRects().length);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      previousFocus.current?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <motion.div
      className={`dialog-scrim ${anchored ? "anchored-scrim" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.18 } }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`planner-dialog ${className}`}
        initial={{ opacity: 0, y: anchored ? 0 : 14, scale: 0.96 }}
        animate={{
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { type: "spring", stiffness: 520, damping: 38, mass: 0.8 },
        }}
        exit={{
          opacity: 0,
          y: anchored ? 0 : 8,
          scale: 0.97,
          transition: { duration: 0.14, ease: [0.4, 0, 1, 1] },
        }}
      >
        {children}
      </motion.section>
    </motion.div>
  );
}
