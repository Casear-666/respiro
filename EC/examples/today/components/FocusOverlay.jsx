// Focus-mode chrome: a quiet hint chip while the rest of the page dims.
import { motion } from "framer-motion";

export function FocusHint() {
  return (
    <motion.div
      className="focus-hint"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6, transition: { duration: 0.18 } }}
      transition={{ duration: 0.3, delay: 0.25 }}
    >
      专注中 · 水面已经静下来 · <kbd>Esc</kbd> 或 <kbd>F</kbd> 退出
    </motion.div>
  );
}
