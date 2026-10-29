/* In-app availability reminders. Asia/Jerusalem, three slots per submission
   week, relative to the Monday 10:00 lock (same deadline as isLocked):
     morning  Sunday 09:00  (day before)
     evening  Sunday 17:00  (day before)
     hour     Monday 09:00  (one hour before)
   The free web process sleeps, so a wake delivers any of those slots whose
   wall time has already passed in the current cycle. The cycle runs from
   Sunday 09:00 until the next Sunday 09:00. One notification id per
   employee, week, channel, and slot — a second pass does not add another.
   v1 writes state.notifications only. A later Resend pass can deliver those
   same rows; this file does not open a socket. */
"use strict";

const REMINDER_TZ = "Asia/Jerusalem";
const REMINDER_SLOTS = [
  { key: "morning", weekday: 0, hour: 9 },
  { key: "evening", weekday: 0, hour: 17 },
  { key: "hour", weekday: 1, hour: 9 }
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function partsInTz(date) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: REMINDER_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = dtf.formatToParts(date);
  const get = type => {
    const found = parts.find(p => p.type === type);
    return found ? found.value : "";
  };
  let hour = +get("hour");
  if (hour === 24) hour = 0;
  return {
    year: +get("year"),
    month: +get("month"),
    day: +get("day"),
    hour,
    minute: +get("minute"),
    second: +get("second"),
    weekday: WEEKDAYS.indexOf(get("weekday"))
  };
}

function tzOffsetMs(utcMs) {
  const p = partsInTz(new Date(utcMs));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

function zonedToUtc(part, hour, minute) {
  const guess = Date.UTC(part.y, part.m - 1, part.d, hour, minute, 0);
  const offset = tzOffsetMs(guess);
  let utc = guess - offset;
  const offset2 = tzOffsetMs(utc);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

function parseYmd(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function addDays(part, days) {
  const dt = new Date(Date.UTC(part.y, part.m - 1, part.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatYmd(part) {
  const p = n => String(n).padStart(2, "0");
  return part.y + "-" + p(part.m) + "-" + p(part.d);
}

function slotsForWeek(weekKey) {
  const start = parseYmd(weekKey);
  if (!start) return [];
  const reminderSunday = addDays(start, -7);
  const monday = addDays(start, -6);
  return [
    { key: "morning", at: zonedToUtc(reminderSunday, 9, 0) },
    { key: "evening", at: zonedToUtc(reminderSunday, 17, 0) },
    { key: "hour", at: zonedToUtc(monday, 9, 0) }
  ];
}

function deadlineForWeek(weekKey) {
  const start = parseYmd(weekKey);
  if (!start) return null;
  return zonedToUtc(addDays(start, -6), 10, 0);
}

/* The submission week whose reminder Sunday is the latest Sunday 09:00
   that has already happened in Jerusalem. */
function activeReminderCycle(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (isNaN(date.getTime())) return null;
  const p = partsInTz(date);
  if (p.weekday < 0) return null;
  const today = { y: p.year, m: p.month, d: p.day };
  const thisSunday = addDays(today, -p.weekday);
  const morningAt = zonedToUtc(thisSunday, 9, 0);
  const reminderSunday = date.getTime() >= morningAt.getTime() ? thisSunday : addDays(thisSunday, -7);
  const weekKey = formatYmd(addDays(reminderSunday, 7));
  const slots = slotsForWeek(weekKey).filter(s => s.at.getTime() <= date.getTime());
  return { weekKey, deadline: deadlineForWeek(weekKey), slots };
}

function weekLabel(weekKey) {
  const start = parseYmd(weekKey);
  if (!start) return weekKey;
  const end = addDays(start, 6);
  const left = start.d + " " + MONTHS[start.m - 1];
  const right = end.d + " " + MONTHS[end.m - 1];
  return left + " – " + right;
}

function reminderCopy(slotKey, weekKey) {
  const label = weekLabel(weekKey);
  if (slotKey === "morning") {
    return {
      title: "Submit your availability",
      body: "Morning reminder: submit your availability for the week of " + label + ". Submissions close Monday at 10:00."
    };
  }
  if (slotKey === "evening") {
    return {
      title: "Availability still missing",
      body: "Evening reminder: you haven't submitted availability for the week of " + label + ". Submissions close Monday at 10:00."
    };
  }
  return {
    title: "Availability closes in an hour",
    body: "Last call: submissions close in about an hour, Monday at 10:00. Submit your availability for the week of " + label + "."
  };
}

function reminderId(channelId, weekKey, slotKey, empId) {
  return ["n_ar", channelId || "all", weekKey, slotKey, empId].join("_").replace(/[^a-zA-Z0-9]+/g, "_");
}

function acceptingSubmissions(wk) {
  if (!wk) return true;
  if (wk.lockOverride === "open") return true;
  if (wk.locked) return false;
  return true;
}

function storedChannels(state) {
  const list = state && state.channels;
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && typeof c.id === "string" && c.id && Array.isArray(c.memberIds));
}

function legacyChannelId(channels) {
  const marked = channels.find(c => c.default || c.id === "ch_default");
  return marked ? marked.id : channels[0].id;
}

function weekRecordFor(weeks, channel, weekKey, legacyId) {
  const alt = channel.id + "|" + weekKey;
  if (weeks[alt]) return weeks[alt];
  const plain = weeks[weekKey];
  if (!plain) return {};
  if (plain.channelId) return plain.channelId === channel.id ? plain : {};
  return channel.id === legacyId ? plain : {};
}

function reminderGroups(state, weekKey) {
  const weeks = (state && state.weeks) || {};
  const channels = storedChannels(state);
  if (!channels.length) {
    return [{ channelId: null, memberIds: null, wk: weeks[weekKey] || {} }];
  }
  const legacyId = legacyChannelId(channels);
  return channels.map(ch => ({
    channelId: ch.id,
    memberIds: ch.memberIds,
    wk: weekRecordFor(weeks, ch, weekKey, legacyId)
  }));
}

function alreadySubmitted(wk, emp) {
  const sub = wk && wk.submissions && wk.submissions[emp.id];
  return !!(sub && sub.submittedAt);
}

function targetsFor(employees, group, isRosterEmail) {
  const members = group.memberIds ? new Set(group.memberIds) : null;
  const seen = new Set();
  const out = [];
  for (const emp of employees || []) {
    if (!emp || !emp.id || emp.pending) continue;
    if (members && !members.has(emp.id)) continue;
    const email = String(emp.email || "").trim().toLowerCase();
    if (!isRosterEmail(email)) continue;
    if (seen.has(email)) continue;
    if (alreadySubmitted(group.wk, emp)) continue;
    seen.add(email);
    out.push(emp);
  }
  return out;
}

function applyAvailabilityReminders(state, now, opts) {
  const isRosterEmail = opts && opts.isRosterEmail;
  if (typeof isRosterEmail !== "function") throw new Error("isRosterEmail required");
  const empty = { created: 0, emailed: 0, weekKey: null, slots: [] };
  if (!state || typeof state !== "object") return empty;
  const cycle = activeReminderCycle(now);
  if (!cycle) return empty;
  if (!Array.isArray(state.notifications)) state.notifications = [];
  const have = new Set(state.notifications.filter(n => n && n.id).map(n => n.id));
  let created = 0;
  for (const group of reminderGroups(state, cycle.weekKey)) {
    if (!acceptingSubmissions(group.wk)) continue;
    for (const slot of cycle.slots) {
      const copy = reminderCopy(slot.key, cycle.weekKey);
      for (const emp of targetsFor(state.employees, group, isRosterEmail)) {
        const id = reminderId(group.channelId, cycle.weekKey, slot.key, emp.id);
        if (have.has(id)) continue;
        const row = {
          id,
          type: "availability_reminder",
          title: copy.title,
          body: copy.body,
          createdAt: slot.at.toISOString(),
          week: cycle.weekKey,
          recipientIds: [emp.id],
          readBy: {},
          slot: slot.key
        };
        if (group.channelId) row.channelId = group.channelId;
        state.notifications.push(row);
        have.add(id);
        created++;
      }
    }
  }
  return {
    created,
    emailed: 0,
    weekKey: cycle.weekKey,
    slots: cycle.slots.map(s => s.key)
  };
}

module.exports = {
  REMINDER_TZ,
  REMINDER_SLOTS,
  partsInTz,
  zonedToUtc,
  parseYmd,
  addDays,
  formatYmd,
  weekLabel,
  slotsForWeek,
  deadlineForWeek,
  activeReminderCycle,
  applyAvailabilityReminders,
  reminderId
};
