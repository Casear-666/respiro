import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { ChevronLeft, ChevronRight, Orbit, Undo2 } from "lucide-react";
import { addDays, dateKey, eventOnDay, localDate, CATEGORIES } from "../shared/domain";
import { DayDial, DialContext } from "../src/planner/DayDial";
import EventEditor from "../src/planner/EventEditor";
import "../src/index.css";
import "../src/planner/planner.css";
import "./dial-demo.css";

const today = dateKey(new Date());
const examples = [
  ["08:00", "09:30", "晨间阅读", "personal"],
  ["10:00", "12:00", "专注设计", "work"],
  ["11:30", "12:15", "项目碰头", "meeting"],
  ["15:00", "16:30", "整理作品集", "urgent"],
  ["19:30", "20:30", "散步与播客", "personal"],
].map(([from, to, title, tag], index) => ({
  id: `sample-${index}`, title, tag, allDay: false,
  start: `${today}T${from}:00`, end: `${today}T${to}:00`,
}));

function Demo() {
  const [day, setDay] = useState(today);
  const [events, setEvents] = useState(examples);
  const [draft, setDraft] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(true);
  const [history, setHistory] = useState([]);
  const [notice, setNotice] = useState("");
  const close = useCallback(() => setDraft(null), []);
  const date = localDate(day);
  function update(next, message) {
    setHistory(current => [...current, { events, day }].slice(-30));
    setEvents(next);
    setNotice(message);
  }
  function save(event) {
    const exists = events.some(item => item.id === event.id);
    update(exists ? events.map(item => item.id === event.id ? event : item) : [...events, event],
      `${exists ? "已更新" : "已添加"}「${event.title}」`);
    setDay(dateKey(localDate(event.start)));
  }
  function undo() {
    const last = history.at(-1);
    if (!last) return;
    setEvents(last.events);
    setDay(last.day);
    setHistory(history.slice(0, -1));
    setNotice("已撤销");
  }
  return <MotionConfig reducedMotion="user">
    <main className="tide-shell">
      <header className="tide-mast"><div><Orbit aria-hidden="true" size={23} /><b>精力日历</b></div><span>表盘预览</span></header>
      <div className="tide-heading"><div>
        <h1>昼夜表盘</h1>
        <p>{date.toLocaleDateString("zh-CN", {year:"numeric", month:"long", day:"numeric", weekday:"long"})}</p>
      </div>
      <nav aria-label="选择日期">
        <button aria-label="前一天" onClick={() => setDay(dateKey(addDays(date, -1)))}><ChevronLeft size={17} /></button>
        <button onClick={() => setDay(today)}>今天</button>
        <button aria-label="后一天" onClick={() => setDay(dateKey(addDays(date, 1)))}><ChevronRight size={17} /></button>
      </nav></div>
      <div className="tide-card">
        <DialContext.Provider value={{ events, onCreate: setDraft,
          onEdit: (id, rect) => setDraft({ event: events.find(item => item.id === id), rect }),
          onDelete: (id) => update(events.filter(item => item.id !== id), "已删除日程") }}>
          <DayDial key={day} day={day} legend={
            <div className="tide-legend" aria-label="日程分类">
              {CATEGORIES.filter(category => events.some(event => event.tag === category.id && eventOnDay(event, day))).map(category =>
                <span key={category.id}><i style={{background: `var(--dial-${category.id})`}} />{category.label}</span>)}
            </div>
          } />
        </DialContext.Provider>
      </div>
      <footer className="tide-footer"><span role="status">{notice || "示例日程仅在当前页面生效"}</span>
        <button disabled={!history.length} onClick={undo}><Undo2 size={15} /> 撤销</button></footer>
    </main>
    <AnimatePresence>{draft && <EventEditor key={draft.event?.id || "new"} draft={draft} onClose={close}
      onSave={save} onDelete={id => update(events.filter(item => item.id !== id), "已删除日程")}
      confirmBeforeDelete={confirmDelete} onSettings={settings => setConfirmDelete(settings.confirmBeforeDelete)} />}</AnimatePresence>
  </MotionConfig>;
}

createRoot(document.getElementById("root")).render(<Demo />);
