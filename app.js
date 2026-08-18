'use strict';

const firebaseConfig = {
  apiKey: "AIzaSyDkjQnH6Z-u4BUPa4-KWVsV5ggdARxZY9w",
  authDomain: "kml-holiday-tracker.firebaseapp.com",
  projectId: "kml-holiday-tracker",
  storageBucket: "kml-holiday-tracker.firebasestorage.app",
  messagingSenderId: "1072716134546",
  appId: "1:1072716134546:web:d2bea1fc1c10ff6ed78e4b"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const SHARED_LOGIN_EMAIL = 'jacob@kmlfoodservice.internal';

const STORAGE_KEY = 'kml-holiday-tracker-v1';

const DEFAULT_SETTINGS = {
  yearStartMonth: 1,     // 1 = January
  yearStartDay: 1,
  accrualRate: 12.07,    // % of hours worked, UK statutory default for irregular hours
  annualDays: 28,        // full-time statutory minimum, fixed-hours staff
  fullTimeHours: 40,     // hrs/week counted as full time
  hoursPerDay: 8,        // for hrs <-> days conversion/display
};

let state = loadState();
let currentYear = null; // holiday-year label (the calendar year the holiday year starts in), set in init
let calMonth = null;    // first-of-month Date shown on the Calendar tab, set in init
let calView = 'timeline';

// England & Wales bank holidays only (not Scotland/NI). Source: gov.uk, 2025-2028.
// Years outside this range simply show no bank-holiday markers.
const BANK_HOLIDAYS = {
  '2025-01-01': "New Year's Day",
  '2025-04-18': "Good Friday",
  '2025-04-21': "Easter Monday",
  '2025-05-05': "Early May bank holiday",
  '2025-05-26': "Spring bank holiday",
  '2025-08-25': "Summer bank holiday",
  '2025-12-25': "Christmas Day",
  '2025-12-26': "Boxing Day",
  '2026-01-01': "New Year's Day",
  '2026-04-03': "Good Friday",
  '2026-04-06': "Easter Monday",
  '2026-05-04': "Early May bank holiday",
  '2026-05-25': "Spring bank holiday",
  '2026-08-31': "Summer bank holiday",
  '2026-12-25': "Christmas Day",
  '2026-12-28': "Boxing Day (substitute)",
  '2027-01-01': "New Year's Day",
  '2027-03-26': "Good Friday",
  '2027-03-29': "Easter Monday",
  '2027-05-03': "Early May bank holiday",
  '2027-05-31': "Spring bank holiday",
  '2027-08-30': "Summer bank holiday",
  '2027-12-27': "Christmas Day (substitute)",
  '2027-12-28': "Boxing Day (substitute)",
  '2028-01-03': "New Year's Day (substitute)",
  '2028-04-14': "Good Friday",
  '2028-04-17': "Easter Monday",
  '2028-05-01': "Early May bank holiday",
  '2028-05-29': "Spring bank holiday",
  '2028-08-28': "Summer bank holiday",
  '2028-12-25': "Christmas Day",
  '2028-12-26': "Boxing Day",
};

const STAFF_COLORS = ['#3F6FBF', '#1D9A8C', '#9A5BC2', '#C77F1E', '#C24E82', '#4F63C2', '#8A6D3B', '#3B8FA6', '#5C7AA6', '#7A5C99'];
function getStaffColor(staffId) {
  const idx = state.staff.findIndex(s => s.id === staffId);
  return STAFF_COLORS[(idx < 0 ? 0 : idx) % STAFF_COLORS.length];
}

// ---------- persistence ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return {
      staff: parsed.staff || [],
      hoursEntries: parsed.hoursEntries || [],
      holidayEntries: parsed.holidayEntries || [],
      settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
    };
  } catch (e) {
    console.error('Failed to load stored data, starting fresh.', e);
    return freshState();
  }
}

function freshState() {
  return { staff: [], hoursEntries: [], holidayEntries: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- cloud sync (Firestore) ----------

function syncStaffToCloud(record) {
  if (!auth.currentUser) return;
  db.collection('staff').doc(record.id).set(record).catch(err => console.error('Cloud sync failed for staff', record.id, err));
}
function deleteStaffFromCloud(id) {
  if (!auth.currentUser) return;
  db.collection('staff').doc(id).delete().catch(err => console.error('Cloud delete failed for staff', id, err));
}
function syncHoursEntryToCloud(entry) {
  if (!auth.currentUser) return;
  db.collection('hoursEntries').doc(entry.id).set(entry).catch(err => console.error('Cloud sync failed for hours entry', entry.id, err));
}
function deleteHoursEntryFromCloud(id) {
  if (!auth.currentUser) return;
  db.collection('hoursEntries').doc(id).delete().catch(err => console.error('Cloud delete failed for hours entry', id, err));
}
function syncHolidayEntryToCloud(entry) {
  if (!auth.currentUser) return;
  db.collection('holidayEntries').doc(entry.id).set(entry).catch(err => console.error('Cloud sync failed for holiday entry', entry.id, err));
}
function deleteHolidayEntryFromCloud(id) {
  if (!auth.currentUser) return;
  db.collection('holidayEntries').doc(id).delete().catch(err => console.error('Cloud delete failed for holiday entry', id, err));
}
function syncSettingsToCloud() {
  if (!auth.currentUser) return;
  db.collection('settings').doc('main').set(state.settings).catch(err => console.error('Cloud sync failed for settings', err));
}

async function syncFullStateToCloud() {
  if (!auth.currentUser) return;
  const collections = [
    { name: 'staff', items: state.staff },
    { name: 'hoursEntries', items: state.hoursEntries },
    { name: 'holidayEntries', items: state.holidayEntries },
  ];
  for (const { name, items } of collections) {
    const existing = await db.collection(name).get();
    const keepIds = new Set(items.map(i => i.id));
    const batch = db.batch();
    existing.docs.forEach(doc => { if (!keepIds.has(doc.id)) batch.delete(doc.ref); });
    items.forEach(item => batch.set(db.collection(name).doc(item.id), item));
    await batch.commit();
  }
  await db.collection('settings').doc('main').set(state.settings);
}

let unsubscribeStaff = null, unsubscribeHoursEntries = null, unsubscribeHolidayEntries = null, unsubscribeSettings = null;

function subscribeCloud() {
  unsubscribeStaff = db.collection('staff').onSnapshot(snapshot => {
    state.staff = snapshot.docs.map(doc => doc.data());
    saveState();
    renderAll();
  }, err => console.error('Staff subscription failed', err));

  unsubscribeHoursEntries = db.collection('hoursEntries').onSnapshot(snapshot => {
    state.hoursEntries = snapshot.docs.map(doc => doc.data());
    saveState();
    renderAll();
  }, err => console.error('Hours entries subscription failed', err));

  unsubscribeHolidayEntries = db.collection('holidayEntries').onSnapshot(snapshot => {
    state.holidayEntries = snapshot.docs.map(doc => doc.data());
    saveState();
    renderAll();
  }, err => console.error('Holiday entries subscription failed', err));

  unsubscribeSettings = db.collection('settings').doc('main').onSnapshot(doc => {
    if (doc.exists) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, doc.data());
      saveState();
      currentYear = null;
      renderAll();
    } else if (auth.currentUser) {
      // first login ever for this project — seed the cloud settings doc from local defaults
      db.collection('settings').doc('main').set(state.settings).catch(err => console.error('Failed to seed settings', err));
    }
  }, err => console.error('Settings subscription failed', err));
}

function unsubscribeCloud() {
  if (unsubscribeStaff) { unsubscribeStaff(); unsubscribeStaff = null; }
  if (unsubscribeHoursEntries) { unsubscribeHoursEntries(); unsubscribeHoursEntries = null; }
  if (unsubscribeHolidayEntries) { unsubscribeHolidayEntries(); unsubscribeHolidayEntries = null; }
  if (unsubscribeSettings) { unsubscribeSettings(); unsubscribeSettings = null; }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- date helpers ----------

function toDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fromDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDate(str) {
  const d = toDate(str);
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function daysBetweenInclusive(a, b) {
  return Math.round((b - a) / 86400000) + 1;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
function isWeekend(d) { const wd = d.getDay(); return wd === 0 || wd === 6; }
function monthLabel(d) { return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
function eachDateStr(fromStr, toStr) {
  const out = [];
  let d = toDate(fromStr);
  const end = toDate(toStr);
  while (d <= end) {
    out.push(fromDate(d));
    d = addDays(d, 1);
  }
  return out;
}
function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function getHolidayYearBounds(yearLabel) {
  const { yearStartMonth, yearStartDay } = state.settings;
  const start = new Date(yearLabel, yearStartMonth - 1, yearStartDay);
  const end = new Date(yearLabel + 1, yearStartMonth - 1, yearStartDay - 1);
  return { start, end };
}

function holidayYearLabelForDate(date) {
  const { yearStartMonth, yearStartDay } = state.settings;
  const boundaryThisCalYear = new Date(date.getFullYear(), yearStartMonth - 1, yearStartDay);
  return date >= boundaryThisCalYear ? date.getFullYear() : date.getFullYear() - 1;
}

function getYearOptions() {
  const today = new Date();
  const labels = new Set();
  labels.add(holidayYearLabelForDate(today));
  state.staff.forEach(s => { if (s.startDate) labels.add(holidayYearLabelForDate(toDate(s.startDate))); });
  state.hoursEntries.forEach(e => { if (e.from) labels.add(holidayYearLabelForDate(toDate(e.from))); });
  state.holidayEntries.forEach(e => { if (e.from) labels.add(holidayYearLabelForDate(toDate(e.from))); });
  const min = Math.min(...labels), max = Math.max(...labels, holidayYearLabelForDate(today) + 1);
  const out = [];
  for (let y = min; y <= max; y++) out.push(y);
  return out;
}

// ---------- calculations ----------

function computeStaffSummary(staffMember, yearLabel) {
  const { start, end } = getHolidayYearBounds(yearLabel);
  const { accrualRate, annualDays, fullTimeHours, hoursPerDay } = state.settings;

  const hoursWorked = state.hoursEntries
    .filter(e => e.staffId === staffMember.id && inBounds(e.from, start, end))
    .reduce((sum, e) => sum + Number(e.hours || 0), 0);

  const hoursTaken = state.holidayEntries
    .filter(e => e.staffId === staffMember.id && inBounds(e.from, start, end))
    .reduce((sum, e) => sum + (e.unit === 'days' ? Number(e.amount || 0) * hoursPerDay : Number(e.amount || 0)), 0);
  const daysTaken = hoursTaken / hoursPerDay;

  let accruedHours = null, entitlementDays = null;

  if (staffMember.type === 'hourly') {
    accruedHours = hoursWorked * (accrualRate / 100);
  } else {
    const empStart = staffMember.startDate ? toDate(staffMember.startDate) : start;
    const empEnd = staffMember.leaveDate ? toDate(staffMember.leaveDate) : end;
    const overlapStart = empStart > start ? empStart : start;
    const overlapEnd = empEnd < end ? empEnd : end;
    if (overlapEnd >= overlapStart) {
      const employedDays = daysBetweenInclusive(overlapStart, overlapEnd);
      const totalDays = daysBetweenInclusive(start, end);
      const fraction = employedDays / totalDays;
      const contracted = Number(staffMember.contractedHours || fullTimeHours);
      entitlementDays = annualDays * (contracted / fullTimeHours) * fraction;
    } else {
      entitlementDays = 0;
    }
  }

  let remainingHours, remainingDays;
  if (staffMember.type === 'hourly') {
    remainingHours = accruedHours - hoursTaken;
    remainingDays = remainingHours / hoursPerDay;
  } else {
    remainingDays = entitlementDays - daysTaken;
    remainingHours = remainingDays * hoursPerDay;
  }

  return { hoursWorked, hoursTaken, daysTaken, accruedHours, entitlementDays, remainingHours, remainingDays };
}

function inBounds(dateStr, start, end) {
  if (!dateStr) return false;
  const d = toDate(dateStr);
  return d >= start && d <= end;
}

function buildOffMap(viewStartStr, viewEndStr) {
  const map = new Map();
  state.holidayEntries.forEach(e => {
    const staffMember = state.staff.find(s => s.id === e.staffId);
    if (!staffMember) return;
    const from = e.from > viewStartStr ? e.from : viewStartStr;
    const to = e.to < viewEndStr ? e.to : viewEndStr;
    if (from > to) return;
    eachDateStr(from, to).forEach(dateStr => {
      if (!map.has(dateStr)) map.set(dateStr, []);
      map.get(dateStr).push({ staffId: staffMember.id, name: staffMember.name, role: staffMember.role, active: staffMember.active });
    });
  });
  return map;
}

function computeConflicts(offMap) {
  const conflictDates = new Set();
  const conflictCells = new Set();
  const details = [];
  offMap.forEach((entries, dateStr) => {
    const byRole = {};
    entries.forEach(en => {
      if (!en.active || !en.role) return;
      (byRole[en.role] = byRole[en.role] || []).push(en);
    });
    Object.entries(byRole).forEach(([role, ens]) => {
      if (ens.length >= 2) {
        conflictDates.add(dateStr);
        ens.forEach(en => conflictCells.add(`${dateStr}|${en.staffId}`));
        details.push({ date: dateStr, role, names: ens.map(en => en.name) });
      }
    });
  });
  return { conflictDates, conflictCells, details };
}

// ---------- rendering ----------

function activeStaff() { return state.staff.filter(s => s.active); }

function initials(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase())
    .slice(0, 2)
    .join('');
}

function renderYearPicker() {
  const sel = document.getElementById('year-picker');
  const years = getYearOptions();
  if (currentYear === null || !years.includes(currentYear)) {
    currentYear = holidayYearLabelForDate(new Date());
    if (!years.includes(currentYear)) years.push(currentYear);
  }
  sel.innerHTML = years.map(y => {
    const { start, end } = getHolidayYearBounds(y);
    const label = `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} – ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    return `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

function renderDashboard() {
  const tbody = document.getElementById('dashboard-tbody');
  const alertsEl = document.getElementById('dashboard-alerts');
  const statsEl = document.getElementById('dashboard-stats');
  const rows = [];
  const alerts = [];
  let negativeCount = 0;

  state.staff.forEach(s => {
    const sum = computeStaffSummary(s, currentYear);
    const isHourly = s.type === 'hourly';
    const mainCol = isHourly
      ? `${sum.accruedHours.toFixed(2)} hrs <span class="secondary">(${(sum.accruedHours / state.settings.hoursPerDay).toFixed(1)} days)</span>`
      : `${sum.entitlementDays.toFixed(1)} days`;
    const takenCol = isHourly
      ? `${sum.hoursTaken.toFixed(2)} hrs <span class="secondary">(${sum.daysTaken.toFixed(1)} days)</span>`
      : `${sum.daysTaken.toFixed(1)} days`;
    const remainingVal = isHourly ? sum.remainingHours : sum.remainingDays;
    const remainingUnit = isHourly ? 'hrs' : 'days';
    const negative = remainingVal < -0.001;
    const remainingCol = `<span class="${negative ? 'pill pill-negative' : ''}">${remainingVal.toFixed(isHourly ? 2 : 1)} ${remainingUnit}</span>`;

    if (negative && s.active) {
      negativeCount++;
      alerts.push(`${s.name} has a negative holiday balance for this holiday year (${remainingVal.toFixed(isHourly ? 2 : 1)} ${remainingUnit}).`);
    }

    rows.push(`
      <tr>
        <td><div class="staff-cell clickable" data-view-staff="${s.id}"><span class="avatar" style="background:${getStaffColor(s.id)};color:#fff">${escapeHtml(initials(s.name))}</span>${escapeHtml(s.name)}${s.active ? '' : ' <span class="pill pill-inactive">inactive</span>'}</div></td>
        <td><span class="pill ${isHourly ? 'pill-hourly' : 'pill-fixed'}">${isHourly ? 'Hourly' : 'Fixed hours'}</span></td>
        <td>${mainCol}</td>
        <td>${takenCol}</td>
        <td>${remainingCol}</td>
      </tr>`);
  });

  tbody.innerHTML = rows.length ? rows.join('') : `<tr class="empty-row"><td colspan="5">No staff added yet. Go to the Staff tab to add your first staff member.</td></tr>`;
  alertsEl.innerHTML = alerts.map(a => `<div class="alert">${escapeHtml(a)}</div>`).join('');

  const totalStaff = state.staff.length;
  const numActive = activeStaff().length;
  statsEl.innerHTML = `
    <div class="stat-card">
      <span class="stat-value">${totalStaff}</span>
      <span class="stat-label">Total staff</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${numActive}</span>
      <span class="stat-label">Active</span>
    </div>
    <div class="stat-card ${negativeCount ? 'warn' : ''}">
      <span class="stat-value">${negativeCount}</span>
      <span class="stat-label">Negative balance</span>
    </div>`;
}

function renderStaffTable() {
  const tbody = document.getElementById('staff-tbody');
  if (!state.staff.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No staff yet. Click "+ Add staff" to get started.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.staff.map(s => `
    <tr>
      <td><div class="staff-cell clickable" data-view-staff="${s.id}"><span class="avatar" style="background:${getStaffColor(s.id)};color:#fff">${escapeHtml(initials(s.name))}</span>${escapeHtml(s.name)}</div></td>
      <td>${escapeHtml(s.role || '—')}</td>
      <td><span class="pill ${s.type === 'hourly' ? 'pill-hourly' : 'pill-fixed'}">${s.type === 'hourly' ? 'Hourly' : 'Fixed hours'}</span></td>
      <td>${fmtDate(s.startDate)}</td>
      <td class="num">${s.contractedHours || '—'}</td>
      <td><span class="pill ${s.active ? 'pill-active' : 'pill-inactive'}">${s.active ? 'Active' : 'Inactive'}</span></td>
      <td><button class="link-btn" data-edit-staff="${s.id}">Edit</button></td>
    </tr>`).join('');
}

function renderStaffSelects() {
  const opts = state.staff.map(s => `<option value="${s.id}" ${!s.active ? 'disabled' : ''}>${escapeHtml(s.name)}${!s.active ? ' (inactive)' : ''}</option>`).join('');
  const hoursSel = document.getElementById('hours-staff');
  const holSel = document.getElementById('holiday-staff');
  const placeholder = `<option value="" disabled selected>Select staff…</option>`;
  hoursSel.innerHTML = placeholder + opts;
  holSel.innerHTML = placeholder + opts;
}

function staffName(id) {
  const s = state.staff.find(s => s.id === id);
  return s ? s.name : '(removed staff)';
}

function renderHoursTable() {
  const tbody = document.getElementById('hours-tbody');
  const entries = state.hoursEntries.slice().sort((a, b) => b.from.localeCompare(a.from));
  if (!entries.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No hours logged yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map(e => {
    const accrued = e.hours * (state.settings.accrualRate / 100);
    return `
    <tr>
      <td>${escapeHtml(staffName(e.staffId))}</td>
      <td>${fmtDate(e.from)} – ${fmtDate(e.to)}</td>
      <td class="num">${Number(e.hours).toFixed(2)}</td>
      <td class="num">${accrued.toFixed(2)}</td>
      <td>${escapeHtml(e.notes || '')}</td>
      <td><button class="link-btn danger" data-del-hours="${e.id}">Delete</button></td>
    </tr>`;
  }).join('');
}

function renderHolidayTable() {
  const tbody = document.getElementById('holiday-tbody');
  const entries = state.holidayEntries.slice().sort((a, b) => b.from.localeCompare(a.from));
  if (!entries.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No holidays recorded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map(e => `
    <tr>
      <td>${escapeHtml(staffName(e.staffId))}</td>
      <td>${fmtDate(e.from)} – ${fmtDate(e.to)}</td>
      <td class="num">${Number(e.amount).toFixed(2)} ${e.unit}</td>
      <td>${escapeHtml(e.notes || '')}</td>
      <td><button class="link-btn danger" data-del-holiday="${e.id}">Delete</button></td>
    </tr>`).join('');
}

function renderSettingsForm() {
  const s = state.settings;
  document.getElementById('set-accrual-rate').value = s.accrualRate;
  document.getElementById('set-annual-days').value = s.annualDays;
  document.getElementById('set-fulltime-hours').value = s.fullTimeHours;
  document.getElementById('set-hours-per-day').value = s.hoursPerDay;

  const daySel = document.getElementById('set-year-start-day');
  const monthSel = document.getElementById('set-year-start-month');
  if (!daySel.options.length) {
    daySel.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthSel.innerHTML = months.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  }
  daySel.value = s.yearStartDay;
  monthSel.value = s.yearStartMonth;
}

function renderUpcomingHolidays() {
  const el = document.getElementById('dashboard-upcoming');
  const todayS = fromDate(new Date());
  const horizon = fromDate(addDays(new Date(), 14));
  const items = state.holidayEntries
    .map(e => ({ e, s: state.staff.find(st => st.id === e.staffId) }))
    .filter(x => x.s && x.s.active && x.e.to >= todayS && x.e.from <= horizon)
    .sort((a, b) => a.e.from.localeCompare(b.e.from))
    .slice(0, 6);

  if (!items.length) { el.innerHTML = ''; return; }

  const rows = items.map(({ e, s }) => {
    let whenLabel, whenClass;
    if (e.from <= todayS && e.to >= todayS) {
      whenLabel = 'Ongoing'; whenClass = 'today';
    } else {
      const daysUntil = Math.round((toDate(e.from) - toDate(todayS)) / 86400000);
      if (daysUntil === 0) { whenLabel = 'Today'; whenClass = 'today'; }
      else if (daysUntil === 1) { whenLabel = 'Tomorrow'; whenClass = 'soon'; }
      else { whenLabel = `In ${daysUntil} days`; whenClass = daysUntil <= 3 ? 'soon' : ''; }
    }
    return `
      <div class="upcoming-item">
        <span class="avatar" style="background:${getStaffColor(s.id)};color:#fff">${escapeHtml(initials(s.name))}</span>
        <div>
          <div class="upcoming-name">${escapeHtml(s.name)}</div>
          <div class="upcoming-role">${escapeHtml(s.role || '—')}</div>
        </div>
        <div class="upcoming-dates">
          <span class="upcoming-when ${whenClass}">${whenLabel}</span>
          ${fmtDate(e.from)} – ${fmtDate(e.to)}
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="upcoming-title">Upcoming holidays</div>${rows}`;
}

// ---------- calendar ----------

function renderCalendar() {
  document.getElementById('cal-month-label').textContent = monthLabel(calMonth);
  const viewStart = fromDate(startOfMonth(calMonth));
  const viewEnd = fromDate(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0));
  const offMap = buildOffMap(viewStart, viewEnd);
  const { conflictDates, conflictCells, details } = computeConflicts(offMap);

  renderCalLegend();
  renderCalConflicts(details);

  document.getElementById('cal-timeline-wrap').style.display = calView === 'timeline' ? '' : 'none';
  document.getElementById('cal-month-wrap').style.display = calView === 'month' ? '' : 'none';

  if (calView === 'timeline') renderTimeline(offMap, conflictCells);
  else renderMonthGrid(offMap, conflictDates);
}

function renderCalLegend() {
  const el = document.getElementById('cal-legend');
  const staffItems = activeStaff().map(s => `<span class="legend-item"><span class="legend-dot" style="background:${getStaffColor(s.id)}"></span>${escapeHtml(s.name)}</span>`).join('');
  el.innerHTML = staffItems
    + `<span class="legend-item"><span class="legend-dot bankhol"></span>Bank holiday</span>`
    + `<span class="legend-item"><span class="legend-dot conflict"></span>Coverage conflict</span>`;
}

function renderCalConflicts(details) {
  const el = document.getElementById('cal-conflicts');
  if (!details.length) { el.innerHTML = ''; return; }
  const sorted = details.slice().sort((a, b) => a.date.localeCompare(b.date));
  const shown = sorted.slice(0, 5);
  el.innerHTML = shown.map(d => {
    const verb = d.names.length > 2 ? 'are all off' : 'are both off';
    return `<div class="conflict-alert">${escapeHtml(joinNames(d.names))} ${verb} on ${fmtDate(d.date)} (${escapeHtml(d.role)}) — check cover.</div>`;
  }).join('') + (sorted.length > shown.length
    ? `<div class="conflict-alert">+${sorted.length - shown.length} more coverage conflict${sorted.length - shown.length === 1 ? '' : 's'} this month.</div>`
    : '');
}

function renderTimeline(offMap, conflictCells) {
  const container = document.getElementById('cal-timeline');
  const nDays = daysInMonth(calMonth);
  const todayS = fromDate(new Date());

  let head = `<div class="cal-t-row cal-t-head"><div class="cal-t-staffcol">Staff</div>`;
  for (let day = 1; day <= nDays; day++) {
    const d = new Date(calMonth.getFullYear(), calMonth.getMonth(), day);
    const dateStr = fromDate(d);
    const classes = ['cal-t-daycell'];
    if (isWeekend(d)) classes.push('weekend');
    if (BANK_HOLIDAYS[dateStr]) classes.push('bankhol');
    if (dateStr === todayS) classes.push('today-col');
    head += `<div class="${classes.join(' ')}" title="${BANK_HOLIDAYS[dateStr] ? escapeHtml(BANK_HOLIDAYS[dateStr]) : ''}">${day}</div>`;
  }
  head += `</div>`;

  const rows = state.staff.map(s => {
    let row = `<div class="cal-t-row"><div class="cal-t-staffcol"><div class="staff-cell clickable" data-view-staff="${s.id}"><span class="avatar" style="background:${getStaffColor(s.id)};color:#fff">${escapeHtml(initials(s.name))}</span>${escapeHtml(s.name)}${s.active ? '' : ' <span class="pill pill-inactive">inactive</span>'}</div></div>`;
    for (let day = 1; day <= nDays; day++) {
      const d = new Date(calMonth.getFullYear(), calMonth.getMonth(), day);
      const dateStr = fromDate(d);
      const isOff = (offMap.get(dateStr) || []).some(en => en.staffId === s.id);
      const classes = ['cal-t-daycell'];
      if (isWeekend(d)) classes.push('weekend');
      if (BANK_HOLIDAYS[dateStr]) classes.push('bankhol');
      if (dateStr === todayS) classes.push('today-col');
      let style = '';
      let title = '';
      if (isOff) {
        classes.push('off');
        style = ` style="background:${getStaffColor(s.id)}"`;
        title = `On holiday (${fmtDate(dateStr)})`;
      }
      if (isOff && conflictCells.has(`${dateStr}|${s.id}`)) classes.push('conflict');
      row += `<div class="${classes.join(' ')}"${style} title="${escapeHtml(title)}"></div>`;
    }
    row += `</div>`;
    return row;
  }).join('');

  container.innerHTML = state.staff.length
    ? head + rows
    : head + `<div class="cal-t-row"><div class="cal-t-staffcol" style="border-right:none;">No staff yet — add staff to see them on the calendar.</div></div>`;
}

function renderMonthGrid(offMap, conflictDates) {
  const wrap = document.getElementById('cal-month-grid');
  const first = startOfMonth(calMonth);
  const startWeekday = (first.getDay() + 6) % 7; // 0 = Monday
  const gridStart = addDays(first, -startWeekday);
  const totalCells = 42;
  const todayS = fromDate(new Date());
  const monthIdx = calMonth.getMonth();

  const weekdaysHtml = `<div class="cal-m-weekdays">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<span>${w}</span>`).join('')}</div>`;

  let cellsHtml = '<div class="cal-m-weeks">';
  for (let i = 0; i < totalCells; i++) {
    const d = addDays(gridStart, i);
    const dateStr = fromDate(d);
    const inMonth = d.getMonth() === monthIdx;
    const classes = ['cal-m-day'];
    if (!inMonth) classes.push('other-month');
    if (isWeekend(d)) classes.push('weekend');
    if (BANK_HOLIDAYS[dateStr]) classes.push('bankhol');
    if (dateStr === todayS) classes.push('today');
    if (conflictDates.has(dateStr)) classes.push('conflict');

    const entries = offMap.get(dateStr) || [];
    const shown = entries.slice(0, 3);
    const pillsHtml = shown.map(en => `<span class="cal-m-pill" style="background:${getStaffColor(en.staffId)}" title="${escapeHtml(en.name)}${en.role ? ' · ' + escapeHtml(en.role) : ''}">${escapeHtml(en.name)}</span>`).join('');
    const moreHtml = entries.length > 3 ? `<span class="cal-m-more">+${entries.length - 3} more</span>` : '';
    const bankName = BANK_HOLIDAYS[dateStr] ? `<span class="cal-m-bankname">${escapeHtml(BANK_HOLIDAYS[dateStr])}</span>` : '';

    cellsHtml += `<div class="${classes.join(' ')}"><span class="cal-m-daynum">${d.getDate()}</span>${bankName}<div class="cal-m-pills">${pillsHtml}${moreHtml}</div></div>`;
  }
  cellsHtml += '</div>';

  wrap.innerHTML = weekdaysHtml + cellsHtml;
}

function renderAll() {
  renderYearPicker();
  renderDashboard();
  renderUpcomingHolidays();
  renderCalendar();
  renderStaffTable();
  renderStaffSelects();
  renderHoursTable();
  renderHolidayTable();
  renderSettingsForm();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ---------- tabs ----------

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ---------- staff modal ----------

function openStaffModal(staffId) {
  const overlay = document.getElementById('staff-overlay');
  const form = document.getElementById('staff-form');
  form.reset();
  const deleteBtn = document.getElementById('staff-delete-btn');

  if (staffId) {
    const s = state.staff.find(s => s.id === staffId);
    document.getElementById('staff-modal-title').textContent = 'Edit staff';
    document.getElementById('staff-id').value = s.id;
    document.getElementById('staff-name').value = s.name;
    document.getElementById('staff-role').value = s.role || '';
    document.getElementById('staff-type').value = s.type;
    document.getElementById('staff-start').value = s.startDate || '';
    document.getElementById('staff-contracted').value = s.contractedHours || '';
    document.getElementById('staff-leave').value = s.leaveDate || '';
    document.getElementById('staff-active').checked = !!s.active;
    deleteBtn.style.display = '';
  } else {
    document.getElementById('staff-modal-title').textContent = 'Add staff';
    document.getElementById('staff-id').value = '';
    document.getElementById('staff-active').checked = true;
    deleteBtn.style.display = 'none';
  }
  updateContractedLabel();
  overlay.classList.remove('hidden');
}

function updateContractedLabel() {
  const isHourly = document.getElementById('staff-type').value === 'hourly';
  document.getElementById('staff-contracted-label-text').textContent =
    isHourly ? 'Typical weekly hours (optional)' : 'Contracted hours per week';
}

function closeStaffModal() {
  document.getElementById('staff-overlay').classList.add('hidden');
}

function initStaffModal() {
  document.getElementById('add-staff-btn').addEventListener('click', () => openStaffModal(null));
  document.getElementById('staff-modal-close').addEventListener('click', closeStaffModal);
  document.getElementById('staff-overlay').addEventListener('click', e => { if (e.target.id === 'staff-overlay') closeStaffModal(); });
  document.getElementById('staff-type').addEventListener('change', updateContractedLabel);

  document.getElementById('staff-tbody').addEventListener('click', e => {
    const id = e.target.dataset.editStaff;
    if (id) openStaffModal(id);
  });

  document.getElementById('staff-form').addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('staff-id').value;
    const record = {
      id: id || uid(),
      name: document.getElementById('staff-name').value.trim(),
      role: document.getElementById('staff-role').value.trim(),
      type: document.getElementById('staff-type').value,
      startDate: document.getElementById('staff-start').value,
      contractedHours: document.getElementById('staff-contracted').value || null,
      leaveDate: document.getElementById('staff-leave').value || null,
      active: document.getElementById('staff-active').checked,
    };
    if (!record.name) return;
    if (id) {
      const idx = state.staff.findIndex(s => s.id === id);
      state.staff[idx] = record;
    } else {
      state.staff.push(record);
    }
    saveState();
    syncStaffToCloud(record);
    closeStaffModal();
    renderAll();
  });

  document.getElementById('staff-delete-btn').addEventListener('click', () => {
    const id = document.getElementById('staff-id').value;
    if (!id) return;
    if (!confirm('Delete this staff member? Their logged hours and holiday history will be kept but unlinked. This cannot be undone.')) return;
    state.staff = state.staff.filter(s => s.id !== id);
    saveState();
    deleteStaffFromCloud(id);
    closeStaffModal();
    renderAll();
  });
}

// ---------- staff detail view ----------

function openStaffDetail(staffId) {
  const s = state.staff.find(x => x.id === staffId);
  if (!s) return;
  const sum = computeStaffSummary(s, currentYear);
  const isHourly = s.type === 'hourly';

  const hours = state.hoursEntries.filter(e => e.staffId === staffId).sort((a, b) => b.from.localeCompare(a.from));
  const holidays = state.holidayEntries.filter(e => e.staffId === staffId).sort((a, b) => b.from.localeCompare(a.from));

  const hoursRows = hours.length
    ? hours.map(e => `<tr><td>${fmtDate(e.from)} – ${fmtDate(e.to)}</td><td class="num">${Number(e.hours).toFixed(2)}</td><td>${escapeHtml(e.notes || '')}</td></tr>`).join('')
    : `<tr><td colspan="3" class="detail-empty">No hours logged.</td></tr>`;
  const holidayRows = holidays.length
    ? holidays.map(e => `<tr><td>${fmtDate(e.from)} – ${fmtDate(e.to)}</td><td class="num">${Number(e.amount).toFixed(2)} ${e.unit}</td><td>${escapeHtml(e.notes || '')}</td></tr>`).join('')
    : `<tr><td colspan="3" class="detail-empty">No holidays recorded.</td></tr>`;

  const mainLabel = isHourly ? `${sum.accruedHours.toFixed(2)} hrs` : `${sum.entitlementDays.toFixed(1)} days`;
  const takenLabel = isHourly ? `${sum.hoursTaken.toFixed(2)} hrs` : `${sum.daysTaken.toFixed(1)} days`;
  const remainingVal = isHourly ? sum.remainingHours : sum.remainingDays;
  const remainingLabel = `${remainingVal.toFixed(isHourly ? 2 : 1)} ${isHourly ? 'hrs' : 'days'}`;

  document.getElementById('staff-detail-content').innerHTML = `
    <div class="detail-header">
      <span class="detail-avatar" style="background:${getStaffColor(s.id)};color:#fff">${escapeHtml(initials(s.name))}</span>
      <div>
        <h2>${escapeHtml(s.name)}</h2>
        <div class="detail-role">${escapeHtml(s.role || 'No role set')}</div>
        <div class="detail-badges">
          <span class="pill ${isHourly ? 'pill-hourly' : 'pill-fixed'}">${isHourly ? 'Hourly' : 'Fixed hours'}</span>
          <span class="pill ${s.active ? 'pill-active' : 'pill-inactive'}">${s.active ? 'Active' : 'Inactive'}</span>
        </div>
      </div>
    </div>
    <div class="detail-meta">
      <div><span class="meta-label">Start date</span>${fmtDate(s.startDate)}</div>
      ${s.leaveDate ? `<div><span class="meta-label">Leave date</span>${fmtDate(s.leaveDate)}</div>` : ''}
      ${s.contractedHours ? `<div><span class="meta-label">${s.type === 'fixed' ? 'Contracted hrs/wk' : 'Typical hrs/wk'}</span>${s.contractedHours}</div>` : ''}
    </div>
    <div class="stat-grid">
      <div class="stat-card"><span class="stat-value">${mainLabel}</span><span class="stat-label">${isHourly ? 'Accrued' : 'Entitlement'} this year</span></div>
      <div class="stat-card"><span class="stat-value">${takenLabel}</span><span class="stat-label">Taken this year</span></div>
      <div class="stat-card ${remainingVal < -0.001 ? 'warn' : ''}"><span class="stat-value">${remainingLabel}</span><span class="stat-label">Remaining</span></div>
    </div>
    <div class="detail-section">
      <h4>Holidays taken</h4>
      <div class="detail-scroll"><table class="detail-mini-table"><thead><tr><th>Dates</th><th>Amount</th><th>Notes</th></tr></thead><tbody>${holidayRows}</tbody></table></div>
    </div>
    <div class="detail-section">
      <h4>Hours worked log</h4>
      <div class="detail-scroll"><table class="detail-mini-table"><thead><tr><th>Period</th><th>Hours</th><th>Notes</th></tr></thead><tbody>${hoursRows}</tbody></table></div>
    </div>
  `;
  document.getElementById('staff-detail-overlay').classList.remove('hidden');
}

function closeStaffDetail() {
  document.getElementById('staff-detail-overlay').classList.add('hidden');
}

function initStaffDetail() {
  document.getElementById('staff-detail-close').addEventListener('click', closeStaffDetail);
  document.getElementById('staff-detail-overlay').addEventListener('click', e => { if (e.target.id === 'staff-detail-overlay') closeStaffDetail(); });

  const openFromCell = e => {
    const cell = e.target.closest('.staff-cell[data-view-staff]');
    if (cell) openStaffDetail(cell.dataset.viewStaff);
  };
  document.getElementById('dashboard-tbody').addEventListener('click', openFromCell);
  document.getElementById('staff-tbody').addEventListener('click', openFromCell);
  document.getElementById('cal-timeline').addEventListener('click', openFromCell);
}

// ---------- calendar controls ----------

function initCalendar() {
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      calView = btn.dataset.calView;
      renderCalendar();
    });
  });
  document.getElementById('cal-prev-btn').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('cal-next-btn').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById('cal-today-btn').addEventListener('click', () => {
    calMonth = startOfMonth(new Date());
    renderCalendar();
  });
}

// ---------- hours form ----------

function initHoursForm() {
  document.getElementById('hours-form').addEventListener('submit', e => {
    e.preventDefault();
    const entry = {
      id: uid(),
      staffId: document.getElementById('hours-staff').value,
      from: document.getElementById('hours-from').value,
      to: document.getElementById('hours-to').value,
      hours: Number(document.getElementById('hours-worked').value),
      notes: document.getElementById('hours-notes').value.trim(),
    };
    if (!entry.staffId) return;
    state.hoursEntries.push(entry);
    saveState();
    syncHoursEntryToCloud(entry);
    e.target.reset();
    renderAll();
  });

  document.getElementById('hours-tbody').addEventListener('click', e => {
    const id = e.target.dataset.delHours;
    if (!id) return;
    if (!confirm('Delete this hours entry?')) return;
    state.hoursEntries = state.hoursEntries.filter(x => x.id !== id);
    saveState();
    deleteHoursEntryFromCloud(id);
    renderAll();
  });
}

// ---------- holiday form ----------

function initHolidayForm() {
  document.getElementById('holiday-form').addEventListener('submit', e => {
    e.preventDefault();
    const entry = {
      id: uid(),
      staffId: document.getElementById('holiday-staff').value,
      from: document.getElementById('holiday-from').value,
      to: document.getElementById('holiday-to').value,
      amount: Number(document.getElementById('holiday-amount').value),
      unit: document.getElementById('holiday-unit').value,
      notes: document.getElementById('holiday-notes').value.trim(),
    };
    if (!entry.staffId) return;
    state.holidayEntries.push(entry);
    saveState();
    syncHolidayEntryToCloud(entry);
    e.target.reset();
    renderAll();
  });

  document.getElementById('holiday-tbody').addEventListener('click', e => {
    const id = e.target.dataset.delHoliday;
    if (!id) return;
    if (!confirm('Delete this holiday entry?')) return;
    state.holidayEntries = state.holidayEntries.filter(x => x.id !== id);
    saveState();
    deleteHolidayEntryFromCloud(id);
    renderAll();
  });
}

// ---------- settings ----------

function initSettingsForm() {
  document.getElementById('settings-form').addEventListener('submit', e => {
    e.preventDefault();
    state.settings = {
      yearStartDay: Number(document.getElementById('set-year-start-day').value),
      yearStartMonth: Number(document.getElementById('set-year-start-month').value),
      accrualRate: Number(document.getElementById('set-accrual-rate').value),
      annualDays: Number(document.getElementById('set-annual-days').value),
      fullTimeHours: Number(document.getElementById('set-fulltime-hours').value),
      hoursPerDay: Number(document.getElementById('set-hours-per-day').value),
    };
    saveState();
    syncSettingsToCloud();
    currentYear = null;
    renderAll();
    const msg = document.getElementById('settings-saved-msg');
    msg.textContent = 'Saved.';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  });
}

// ---------- year picker ----------

function initYearPicker() {
  document.getElementById('year-picker').addEventListener('change', e => {
    currentYear = Number(e.target.value);
    renderDashboard();
  });
}

// ---------- export / import ----------

function initDataActions() {
  document.getElementById('export-json-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `kml-holiday-tracker-backup-${fromDate(new Date())}.json`);
  });

  document.getElementById('import-json-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm('Import this backup? It will replace all current data in this browser.')) return;
        state = {
          staff: parsed.staff || [],
          hoursEntries: parsed.hoursEntries || [],
          holidayEntries: parsed.holidayEntries || [],
          settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
        };
        saveState();
        syncFullStateToCloud().catch(err => console.error('Cloud sync failed after import', err));
        currentYear = null;
        renderAll();
        alert('Backup imported.');
      } catch (err) {
        alert('Could not read that file as a valid backup.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('export-csv-btn').addEventListener('click', () => {
    const { start, end } = getHolidayYearBounds(currentYear);
    const header = ['Staff', 'Role', 'Type', 'Holiday year', 'Entitlement/Accrued (days)', 'Taken (days)', 'Remaining (days)'];
    const rows = state.staff.map(s => {
      const sum = computeStaffSummary(s, currentYear);
      const main = s.type === 'hourly' ? (sum.accruedHours / state.settings.hoursPerDay) : sum.entitlementDays;
      const yearLabel = `${fromDate(start)} to ${fromDate(end)}`;
      return [s.name, s.role || '', s.type, yearLabel, main.toFixed(2), sum.daysTaken.toFixed(2), sum.remainingDays.toFixed(2)];
    });
    const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    downloadBlob(blob, `kml-holiday-records-${currentYear}.csv`);
  });
}

function csvCell(val) {
  const s = String(val);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- init ----------

function init() {
  calMonth = startOfMonth(new Date());

  initTabs();
  initStaffModal();
  initStaffDetail();
  initCalendar();
  initHoursForm();
  initHolidayForm();
  initSettingsForm();
  initYearPicker();
  initDataActions();

  const today = fromDate(new Date());
  document.getElementById('hours-to').value = today;
  document.getElementById('holiday-to').value = today;

  renderAll();
}

// ---------- login gate ----------

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginPasscode = document.getElementById('login-passcode');
const loginError = document.getElementById('login-error');
let booted = false;

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector('button');
  btn.disabled = true;
  loginError.textContent = '';
  try {
    await auth.signInWithEmailAndPassword(SHARED_LOGIN_EMAIL, loginPasscode.value);
  } catch (err) {
    loginError.textContent = 'Incorrect passcode.';
  } finally {
    btn.disabled = false;
  }
});

auth.onAuthStateChanged(user => {
  if (user) {
    loginOverlay.classList.add('hidden');
    loginPasscode.value = '';
    if (!booted) {
      booted = true;
      init();
    }
    subscribeCloud();
  } else {
    loginOverlay.classList.remove('hidden');
    unsubscribeCloud();
  }
});
