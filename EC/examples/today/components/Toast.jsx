// Tiny sonner-like toast: one message at a time, ~3.5s, no dependencies.
import { AnimatePresence, motion } from "framer-motion";

export function Toast({ toast }) {
  return (
    <div className="toast-zone" role="status" aria-live="polite">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="toast"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {toast.text}
            {toast.hint && <small>{toast.hint}</small>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
