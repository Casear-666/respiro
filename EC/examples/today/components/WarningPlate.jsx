// HIGH TIDE warning plate: diagonal stripe band + overlap suggestions.
import { motion } from "framer-motion";
import { formatTime } from "../../../shared/domain.js";
import { RollingText } from "./RollingNumber.jsx";

export function WarningPlate({ items }) {
  return (
    <motion.aside
      className="warn-plate"
      initial={{ opacity: 0, x: -26 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -18, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      aria-label="高潮位提醒"
    >
      <div className="warn-band" />
      <h4>
        高潮位 <span className="mono">HIGH TIDE</span>
      </h4>
      <p>
        今日安排重叠 <b><RollingText text={String(items.length)} duration={420} /></b> 处，建议挪走一项：
      </p>
      <ul>
        {items.slice(0, 5).map((a) => (
          <li key={a.event.id}>
            <time className="mono">{formatTime(a.event.start)}</time>
            {a.event.title}
          </li>
        ))}
      </ul>
    </motion.aside>
  );
}
