/**
 * OMNIAGENTS SLOT PICKER – Google Apps Script backend (Code.gs)
 * Reads live availability from Google Calendar and books the chosen slot.
 * Edit only the CONFIG block below when cloning for a new client.
 */
const CONFIG = {
  practiceName: 'CarePoint Medical Centre',
  practicePhone: '021 000 0000',
  eventIcon: '📅',      // Universal icon (works for clinics, salons, physios & workshops)
  slotMinutes: 30,      // Length of one appointment in minutes
  leadMinutes: 60,      // Earliest bookable time = now + 60 minutes
  weeksAhead: 4,        // How many weeks clients can browse

  // One entry per practitioner/staff member. 'primary' = main Google Calendar.
  // For extra calendars: Google Calendar > Settings > copy "Calendar ID".
  practitioners: [
    { name: 'Dr. Van Der Merwe', calendarId: 'primary' }
    // { name: 'Dr. Naidoo', calendarId: 'abc123@group.calendar.google.com' }
  ],

  // Opening hours per weekday (0 = Sunday ... 6 = Saturday). null = closed.
  openingHours: {
    0: null,
    1: ['08:00', '17:00'],
    2: ['08:00', '17:00'],
    3: ['08:00', '17:00'],
    4: ['08:00', '17:00'],
    5: ['08:00', '17:00'],
    6: ['08:00', '13:00']
  },

  periods: [
    { name: 'Morning',   start: '08:00', end: '12:00' },
    { name: 'Afternoon', start: '12:00', end: '16:00' },
    { name: 'Evening',   start: '16:00', end: '19:00' }
  ]
};

const TZ = Session.getScriptTimeZone();
const SLOT_MS = CONFIG.slotMinutes * 60000;

function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'json') {
    return ContentService.createTextOutput(JSON.stringify(nextFreeSlots_(10)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Book an appointment')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Called by Index.html: returns one week of Morning/Afternoon/Evening availability. */
function getWeek(weekOffset, practitionerIndex) {
  weekOffset = Math.max(0, Math.min(CONFIG.weeksAhead - 1, Number(weekOffset) || 0));
  const pracIdx = indexesFor_(practitionerIndex);
  const weekStart = addDays_(startOfDay_(new Date()), weekOffset * 7);
  const weekEnd = addDays_(weekStart, 7);
  const busy = pracIdx.map(i => getBusy_(CONFIG.practitioners[i].calendarId, weekStart, weekEnd));
  const earliest = Date.now() + CONFIG.leadMinutes * 60000;

  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays_(weekStart, i);
    const hours = CONFIG.openingHours[day.getDay()];
    const periods = CONFIG.periods.map(per => {
      if (!hours) return { name: per.name, status: 'closed', times: [] };
      const from = Math.max(at_(day, per.start), at_(day, hours[0]));
      const to = Math.min(at_(day, per.end), at_(day, hours[1]));
      if (from >= to) return { name: per.name, status: 'closed', times: [] };
      if (to <= earliest) return { name: per.name, status: 'past', times: [] };
      const times = [];
      for (let t = from; t + SLOT_MS <= to; t += SLOT_MS) {
        if (t < earliest) continue;
        if (busy.some(b => isFree_(b, t, t + SLOT_MS))) times.push(fmt_(new Date(t), 'HH:mm'));
      }
      return { name: per.name, status: times.length ? 'available' : 'booked', times };
    });
    days.push({ date: fmt_(day, 'yyyy-MM-dd'), label: fmt_(day, 'EEE, dd MMM'), periods });
  }

  return {
    rangeLabel: fmt_(weekStart, 'EEE, dd MMM') + ' - ' + fmt_(addDays_(weekStart, 6), 'EEE, dd MMM'),
    weekOffset: weekOffset,
    weeksAhead: CONFIG.weeksAhead,
    practitioners: CONFIG.practitioners.map(p => p.name),
    practiceName: CONFIG.practiceName,
    practicePhone: CONFIG.practicePhone,
    days: days
  };
}

/** Called by Index.html when the user confirms. Re-checks slot, then creates the Calendar event. */
function bookSlot(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = String(p.date).split('-').map(Number);
    const t = String(p.time).split(':').map(Number);
    const start = new Date(d[0], d[1] - 1, d[2], t[0], t[1]);
    const end = new Date(start.getTime() + SLOT_MS);
    if (start.getTime() < Date.now() + CONFIG.leadMinutes * 60000) {
      return { ok: false, message: 'That time is no longer available. Please choose another slot.' };
    }
    const hours = CONFIG.openingHours[start.getDay()];
    if (!hours || start.getTime() < at_(start, hours[0]) || end.getTime() > at_(start, hours[1])) {
      return { ok: false, message: 'The practice is closed at that time.' };
    }

    const name = clean_(p.name, 60) || 'New Client';
    const phone = clean_(p.phone, 25);
    const service = clean_(p.service, 60) || 'Appointment';

    for (const i of indexesFor_(p.practitionerIndex)) {
      const prac = CONFIG.practitioners[i];
      const cal = getCal_(prac.calendarId);
      if (cal.getEvents(start, end).length === 0) {
        cal.createEvent(CONFIG.eventIcon + ' ' + service + ' – ' + name, start, end, {
          description: 'Booked via OmniAgents WhatsApp Assistant\nClient: ' + name + '\nPhone: ' + phone + '\nService: ' + service
        });
        return {
          ok: true,
          practitioner: prac.name,
          label: fmt_(start, "EEE, dd MMM 'at' HH:mm") + ' with ' + prac.name
        };
      }
    }
    return { ok: false, message: 'Sorry, that slot was just taken. Please pick another time.' };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */
function nextFreeSlots_(limit) {
  const out = [];
  for (let w = 0; w < CONFIG.weeksAhead && out.length < limit; w++) {
    getWeek(w, -1).days.forEach(day => day.periods.forEach(per => {
      if (per.status === 'available' && out.length < limit) {
        out.push({ date: day.date, time: per.times[0], label: day.label + ' – ' + per.name + ' (' + per.times[0] + ')' });
      }
    }));
  }
  return out;
}
function indexesFor_(idx) {
  const n = Number(idx);
  return (idx === '' || idx == null || isNaN(n) || n < 0 || n >= CONFIG.practitioners.length)
    ? CONFIG.practitioners.map((_, i) => i) : [n];
}
function getCal_(id) { return id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id); }
function getBusy_(id, from, to) {
  const cal = getCal_(id);
  if (!cal) throw new Error('Calendar not found: ' + id);
  return cal.getEvents(from, to).map(ev => [ev.getStartTime().getTime(), ev.getEndTime().getTime()]);
}
function isFree_(busy, s, e) { return !busy.some(b => b[0] < e && b[1] > s); }
function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function at_(day, hhmm) { const p = hhmm.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), p[0], p[1]).getTime(); }
function fmt_(d, pattern) { return Utilities.formatDate(d, TZ, pattern); }
function clean_(s, max) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }