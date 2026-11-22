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
    let lastSwitch = 0;
    while (true) {
      if (!document.querySelector('.fc-dayGridMonth-view') && Date.now() - lastSwitch > 400) {
        const btn = [...document.querySelectorAll('.segmented[aria-label="日历视图"] button')]
          .find((b) => b.textContent.includes('月'));
        if (btn) { btn.click(); lastSwitch = Date.now(); }
      }
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
        if (!document.querySelector('.segmented') || typeof require !== 'undefined')
          throw new Error('Missing view switcher or renderer isolation');
        const rows = await window.energyCalendar.list();
        if (rows.length !== 3 || (restored && rows.find(row => row.id === 'smoke-3')?.title !== '已改期并持久化'))
          throw new Error('Saved records did not survive reopening');
        return {title: document.title, records: rows.length, heat: expected, nodeIsolated: true};
      }
      if (Date.now() > until) throw new Error('Packaged calendar/heat restoration timed out; view=' +
        (document.querySelector('.fc-view')?.className || 'none') +
        ' switcher=' + document.querySelectorAll('.segmented[aria-label="日历视图"] button').length +
        ' day=' + (day?.dataset.busyCount ?? 'missing'));
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

async function verifySyncUi(window) {
  const layout = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.storage-card').click();
    const until = Date.now() + 10000;
    while (!document.querySelector('.sync-login input[type="password"]')) {
      if (Date.now() > until) throw new Error('Sync settings did not render');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (!document.querySelector('[aria-label="服务器地址"]') || !document.querySelector('.sync-merge'))
      throw new Error('Missing server or first merge choice');
    document.querySelector('.sync-panel').scrollIntoView({block:'center'});
    await new Promise(resolve => setTimeout(resolve, 700));
    const panel = document.querySelector('.settings-dialog');
    const box = panel.getBoundingClientRect();
    return {opacity:getComputedStyle(panel).opacity, x:box.x,y:box.y,width:box.width,height:box.height, viewport:[innerWidth,innerHeight]};
  })()`);
  if (Number(layout.opacity) < 0.99 || layout.width < 400 || layout.y < 0 || layout.y + layout.height > layout.viewport[1])
    throw new Error("Sync settings are not visibly laid out inside the viewport");
  console.log("SYNC_SETTINGS_LAYOUT", JSON.stringify(layout));
}
async function verifyCloud(window, origin, password) {
  await window.webContents.executeJavaScript(`(async () => {
    const api = window.energyCalendar;
    await api.login({origin:${JSON.stringify(origin)},username:'smoke-user',password:${JSON.stringify(password)}});
    await api.syncNow();
    if ((await api.list()).length !== 0) throw new Error('Account copied local records without consent');
    await api.apply({upserts:[{id:'cloud-smoke',title:'Cloud smoke',start:'2026-11-11',end:'2026-11-12',allDay:true}]});
    const state = await api.syncNow();
    if (state.phase !== 'synced' || state.pending || state.inflight) throw new Error('Desktop upload did not converge: '+state.message);
  })()`);
}
async function prepareRegistration(window, origin, password, desktop = true) {
  await window.webContents.executeJavaScript(`(async () => {
    const desktop = ${JSON.stringify(desktop)};
    const wait = async condition => { const end=Date.now()+12000; while(!await condition()) {
      if(Date.now()>end) throw new Error('Registration UI timed out'); await new Promise(r=>setTimeout(r,25));
    }};
    const fill = (name, value) => {
      const input=document.querySelector('input[name="'+name+'"]');
      if(!input) throw new Error('Missing registration field '+name);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    };
    await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='没有账号？注册账号'));
    if(desktop) { fill('serverOrigin',${JSON.stringify(origin)}); await new Promise(r=>setTimeout(r,0)); }
    [...document.querySelectorAll('button')].find(b=>b.textContent==='没有账号？注册账号').click();
    await wait(()=>document.querySelector('input[name="confirmation"]'));
    fill('username',desktop?'registered-desktop':'registered-web');
    fill('password',${JSON.stringify(password)}); fill('confirmation',${JSON.stringify(password)});
    await new Promise(r=>setTimeout(r,0));
    const form=document.querySelector(desktop?'.sync-login':'.server-gate-card');
    if(!form.checkValidity()) throw new Error('Registration form rejected a valid password');
    form.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,500));
  })()`);
}
async function finishDesktopRegistration(window) {
  await window.webContents.executeJavaScript(`(async () => {
    const api=window.energyCalendar;
    document.querySelector('.sync-login').requestSubmit();
    const until=Date.now()+12000;
    while((await api.syncInfo()).user?.username!=='registered-desktop' || document.querySelector('.sync-login')) {
      if(Date.now()>until) throw new Error('Desktop registration did not sign in'); await new Promise(r=>setTimeout(r,25));
    }
    await api.syncNow(); if((await api.list()).length) throw new Error('Registration imported local data without consent');
    await api.apply({upserts:[{id:'register-smoke',title:'Registered user schedule',start:'2026-11-12',end:'2026-11-13',allDay:true}]});
    if((await api.syncNow()).phase!=='synced') throw new Error('Registered account did not sync');
    const logout=[...document.querySelectorAll('button')].find(b=>b.textContent==='退出账号，返回本地空间');
    if(!logout) throw new Error('Registered account has no logout button'); logout.click();
    while((await api.syncInfo()).phase!=='local' || !document.querySelector('.sync-login')) {
      if(Date.now()>until) throw new Error('Registered account logout failed'); await new Promise(r=>setTimeout(r,25));
    }
    if((await api.list()).length!==3) throw new Error('Registration changed original local space');
  })()`);
}
async function finishWebRegistration(window) {
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.server-gate-card').requestSubmit();
    const until=Date.now()+12000;
    while(!document.querySelector('.planner-shell') && !document.querySelector('.storage-card')) {
      if(Date.now()>until) throw new Error('Web registration did not enter calendar'); await new Promise(r=>setTimeout(r,25));
    }
    const me=await (await fetch('/api/auth/me')).json();
    if(me.user?.username!=='registered-web') throw new Error('Wrong web registration account');
    if((await (await fetch('/api/events')).json()).length) throw new Error('New web account is not empty');
    if(typeof window.energyCalendar!=='undefined') throw new Error('Web renderer received desktop IPC');
  })()`);
}
module.exports = { smokeFixtures, verifyHeat, verifyIpc, verifySyncUi, verifyCloud, prepareRegistration, finishDesktopRegistration, finishWebRegistration };
