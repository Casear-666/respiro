// Runs only with --smoke-test, against the isolated temporary profile in main.cjs.
function smokeFixtures() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateKey = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const offset = (days) => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return dateKey(date);
  };
  // Keep both dates in the displayed month, including on the last Sunday of a month.
  const shift = today.getDate() > 1 ? -1 : 1;
  return {
    day: offset(0),
    otherDay: offset(shift),
    otherEnd: offset(shift + 1),
    events: ["work", "personal", "meeting"].map((tag, i) => ({
      id: `smoke-${i + 1}`,
      title: `桌面热力验证 ${i + 1}`,
      start: offset(0),
      end: offset(1),
      allDay: true,
      tag,
    })),
  };
}

async function verifyHeat(window, restored) {
  const fixtures = smokeFixtures();
  return window.webContents.executeJavaScript(`(async () => {
    const fixtures = ${JSON.stringify(fixtures)};
    const restored = ${JSON.stringify(restored)};
    const until = Date.now() + 15000;
    while (true) {
      const day = document.querySelector('.fc-daygrid-day[data-date="' + fixtures.day + '"]');
      const other = document.querySelector('.fc-daygrid-day[data-date="' + fixtures.otherDay + '"]');
      const expected = restored ? [2, 1] : [3];
      if (document.querySelector('.fc-dayGridMonth-view .fc-event') === null &&
          day?.querySelectorAll('.day-dots > i').length === (restored ? 2 : 3) &&
          (!restored || other?.querySelectorAll('.day-dots > i').length === 1) &&
          Number(day?.dataset.busyCount) === (restored ? 2 : 3) &&
          (!restored || Number(other?.dataset.busyCount) === 1) &&
          document.querySelector('.save-indicator.saved') &&
          document.documentElement.dataset.plannerTheme === (restored ? 'dark' : 'light')) {
        const cellColor = getComputedStyle(day.querySelector('.fc-daygrid-day-frame')).backgroundColor;
        if (cellColor === 'rgba(0, 0, 0, 0)')
          throw new Error('The packaged workload CSS did not paint');
        if (restored && cellColor ===
            getComputedStyle(other.querySelector('.fc-daygrid-day-frame')).backgroundColor)
          throw new Error('The packaged workload colors do not reflect overlaps');
        if (!document.querySelector('.energy-legend') || typeof require !== 'undefined')
          throw new Error('Missing legend or renderer isolation');
        const rows = await window.energyCalendar.list();
        if (rows.length !== 3 || (restored && rows.find(row => row.id === 'smoke-3')?.title !== '已改期并持久化'))
          throw new Error('Saved records did not survive reopening');
        return {title: document.title, records: rows.length, heat: expected, nodeIsolated: true};
      }
      if (Date.now() > until) throw new Error('Packaged calendar/heat restoration timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })()`);
}

async function verifyIpc(window) {
  const fixtures = smokeFixtures();
  await window.webContents.executeJavaScript(`(async () => {
    const fixtures = ${JSON.stringify(fixtures)};
    const api = window.energyCalendar;
    const info = await api.info();
    if (!info.desktop || !info.dataPath) throw new Error('Desktop IPC is unavailable');
    const task = {id: 'smoke-timed', title: '精确时间保存', tag: 'work',
      start: fixtures.day + 'T13:15:00', end: fixtures.day + 'T14:45:00'};
    await api.apply({upserts: [task]});
    const created = (await api.list()).find(row => row.id === task.id);
    if (!created || +new Date(created.end) - +new Date(created.start) !== 90 * 60000 ||
        new Date(created.start).getMinutes() !== 15)
      throw new Error('IPC did not preserve the exact event time');
    await api.apply({upserts: [{...fixtures.events[2], title: '已改期并持久化',
      start: fixtures.otherDay, end: fixtures.otherEnd}], deletes: [task.id]});
    const rows = await api.list();
    if (rows.length !== 3 || rows.some(row => row.id === task.id))
      throw new Error('IPC update/delete failed');
    await api.setSettings({theme: 'dark'});
    if ((await api.getSettings()).theme !== 'dark') throw new Error('IPC settings failed');
  })()`);
}

module.exports = { smokeFixtures, verifyHeat, verifyIpc };
