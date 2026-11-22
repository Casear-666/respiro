// Wrap-up summary card beside the dial, with rolling numbers.
import { motion } from "framer-motion";
import { minutesToText } from "../lib/load.js";
import { RollingNumber, RollingText } from "./RollingNumber.jsx";

export function WrapCard({ summary }) {
  if (!summary) return null;
  return (
    <motion.aside
      className="wrap-card"
      initial={{ opacity: 0, x: 26, y: "-50%" }}
      animate={{ opacity: 1, x: 0, y: "-50%" }}
      exit={{ opacity: 0, x: 18, y: "-50%", transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      aria-label="今日总结"
    >
      <div className="wrap-stub mono" aria-hidden="true">
        <span>TIDE REPORT</span>
        <span>{new Date().toISOString().slice(0, 10).replace(/-/g, ".")}</span>
      </div>
      <h3>
        今天完成{" "}
        <b>
          <RollingNumber value={summary.doneCount} /> / {summary.total}
        </b>{" "}
        项
      </h3>
      <dl>
        <div>
          <dt>专注</dt>
          <dd>
            <RollingText
              text={`${Math.floor(summary.focusedMinutes / 60)} 小时 ${summary.focusedMinutes % 60} 分`}
            />
          </dd>
        </div>
        <div>
          <dt>最忙的时段</dt>
          <dd>
            {summary.busiest ? <RollingText text={summary.busiest} /> : "—"}
          </dd>
        </div>
      </dl>
      <p className="wrap-line">不必填满每一个空格，好的计划也容得下变化。</p>
      <p className="wrap-sign">让时间，留有余地。</p>
      <div className="wrap-barcode" aria-hidden="true" />
    </motion.aside>
  );
}
