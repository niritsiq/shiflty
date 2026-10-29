/* Worker home stats. Asia/Jerusalem, same week key as the schedule
   (Sunday YYYY-MM-DD). Hours come from settings.shifts start/end.
   There is no clock-in: actual hours are the scheduled length of
   published assignments whose end has already passed.

   A shift belongs to the calendar day it starts. Overnight (end clock
   at or before the start clock) finishes the next morning, but the
   hours stay on the start date's week and month. The length is the
   clock difference, plus 24 hours when it crosses midnight — a DST
   fallback does not make a 23:00–07:00 shift nine hours. */
"use strict";

const reminders = require("./reminders");

const TZ = reminders.REMINDER_TZ;
const PAST_LIMIT = 5;
const ACTIVITY_LIMIT = 8;
const HOURS_NOTE = "Scheduled hours are the shift length in settings (end minus start, plus 24 hours when the shift ends the next morning). A shift counts on the Asia/Jerusalem day it starts. Actual hours are scheduled hours on published assignments this month whose end time has already passed. Shiftly does not record clock-in.";

function storedChannels(state) {
  const list = state && state.channels;
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && typeof c.id === "string" && c.id && Array.isArray(c.memberIds));
}

function clockMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const hour = +m[1];
  const minute = +m[2];
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/* Scheduled length in minutes. Null when the clock times are not usable. */
function shiftMinutes(shift) {
  if (!shift) return null;
  const start = clockMinutes(shift.start);
  const end = clockMinutes(shift.end);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

function hoursFromMinutes(minutes) {
  return Math.round(minutes * 100 / 60) / 100;
}

function weekDateOf(key) {
  const m = /(\d{4}-\d{2}-\d{2})$/.exec(String(key || ""));
  return m ? m[1] : null;
}

function accessFor(state, emp) {
  const channels = storedChannels(state);
  if (!channels.length) return { implicit: true, channels: [], mine: null, legacyId: null };
  const mine = new Set();
  for (const ch of channels) {
    if (ch.memberIds.includes(emp.id)) mine.add(ch.id);
  }
  const marked = channels.find(c => c.default || c.id === "ch_default");
  return {
    implicit: false,
    channels,
    mine,
    legacyId: marked ? marked.id : channels[0].id
  };
}

function weekChannel(key, wk, access) {
  if (wk && typeof wk.channelId === "string" && wk.channelId) return wk.channelId;
  const prefixed = /^([^|]+)\|(\d{4}-\d{2}-\d{2})$/.exec(String(key || ""));
  if (prefixed) return prefixed[1];
  if (access.implicit) return null;
  return access.legacyId;
}

function weekVisible(key, wk, access, onlyChannel) {
  const cid = weekChannel(key, wk, access);
  if (!access.implicit && (!cid || !access.mine.has(cid))) return false;
  if (onlyChannel && cid !== onlyChannel) return false;
  return true;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthKey(part) {
  return part.y + "-" + pad2(part.m);
}

function currentWeekKey(now) {
  const p = reminders.partsInTz(now);
  if (p.weekday < 0) return null;
  return reminders.formatYmd(reminders.addDays({ y: p.year, m: p.month, d: p.day }, -p.weekday));
}

function currentMonthKey(now) {
  const p = reminders.partsInTz(now);
  return p.year + "-" + pad2(p.month);
}

function shiftMap(state) {
  const out = new Map();
  const list = state && state.settings && state.settings.shifts;
  if (!Array.isArray(list)) return out;
  for (const shift of list) {
    if (!shift || !shift.id || out.has(shift.id)) continue;
    out.set(shift.id, shift);
  }
  return out;
}

function publicShift(raw) {
  return {
    week: raw.week,
    channelId: raw.channelId,
    dayIdx: raw.dayIdx,
    date: raw.date,
    shiftId: raw.shiftId,
    name: raw.name,
    start: raw.start,
    end: raw.end,
    endsNextDay: raw.endsNextDay,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    hours: raw.hours,
    status: raw.status
  };
}

function collectShifts(state, emp, access, onlyChannel) {
  const defs = shiftMap(state);
  const weeks = (state && state.weeks) || {};
  const rows = [];
  for (const [key, wk] of Object.entries(weeks)) {
    if (!wk || typeof wk !== "object" || wk.published !== true) continue;
    if (!weekVisible(key, wk, access, onlyChannel)) continue;
    const week = weekDateOf(key);
    const sunday = reminders.parseYmd(week);
    if (!sunday || !wk.assignments || typeof wk.assignments !== "object") continue;
    const channelId = weekChannel(key, wk, access);
    for (const cell of Object.keys(wk.assignments)) {
      const parsed = /^([0-6])\.(.+)$/.exec(cell);
      if (!parsed) continue;
      const list = wk.assignments[cell];
      if (!Array.isArray(list) || !list.includes(emp.id)) continue;
      const dayIdx = +parsed[1];
      const shiftId = parsed[2];
      const def = defs.get(shiftId);
      const minutes = shiftMinutes(def);
      if (minutes == null) continue;
      const startMin = clockMinutes(def.start);
      const endMin = clockMinutes(def.end);
      const startPart = reminders.addDays(sunday, dayIdx);
      const endsNextDay = endMin <= startMin;
      const endPart = endsNextDay ? reminders.addDays(startPart, 1) : startPart;
      const starts = reminders.zonedToUtc(startPart, Math.floor(startMin / 60), startMin % 60);
      const ends = reminders.zonedToUtc(endPart, Math.floor(endMin / 60), endMin % 60);
      rows.push({
        week,
        channelId,
        dayIdx,
        date: reminders.formatYmd(startPart),
        shiftId,
        name: String(def.name || shiftId),
        start: String(def.start).trim(),
        end: String(def.end).trim(),
        endsNextDay,
        startsAt: starts.toISOString(),
        endsAt: ends.toISOString(),
        startsMs: starts.getTime(),
        endsMs: ends.getTime(),
        minutes,
        hours: hoursFromMinutes(minutes),
        month: monthKey(startPart)
      });
    }
  }
  return rows;
}

function publicActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return null;
  const name = String(actor.name || "").trim();
  const email = String(actor.email || "").trim();
  if (!name && !email) return null;
  return {
    id: actor.id ? String(actor.id) : null,
    name: name || email,
    email: email || null
  };
}

function readAtFor(n, emp) {
  if (n.readBy && typeof n.readBy === "object" && n.readBy[emp.id]) return n.readBy[emp.id];
  return n.readAt || null;
}

/* Same visibility as the bell, limited to schedule_published. */
function activityRows(state, emp, access, onlyChannel) {
  const list = Array.isArray(state && state.notifications) ? state.notifications : [];
  const rows = [];
  for (const n of list) {
    if (!n || typeof n !== "object" || !n.id || n.type !== "schedule_published") continue;
    const recipients = Array.isArray(n.recipientIds) ? n.recipientIds : [];
    if (recipients.length && !recipients.includes(emp.id) && !recipients.includes(emp.email)) continue;
    if (n.channelId) {
      if (!access.implicit && !access.mine.has(n.channelId)) continue;
    } else if (!access.implicit && !recipients.length) {
      continue;
    }
    if (onlyChannel && n.channelId && n.channelId !== onlyChannel) continue;
    let day = null;
    if (Number.isInteger(n.dayIdx) && n.dayIdx >= 0 && n.dayIdx <= 6) day = n.dayIdx;
    rows.push({
      id: String(n.id),
      type: n.type,
      title: String(n.title || "Schedule published"),
      body: String(n.body || ""),
      createdAt: n.createdAt || null,
      readAt: readAtFor(n, emp),
      channelId: n.channelId || null,
      week: typeof n.week === "string" ? n.week : null,
      dayIdx: day,
      shiftId: n.shiftId || null,
      actor: publicActor(n.actor)
    });
  }
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return rows.slice(0, ACTIVITY_LIMIT);
}

function emptyHome(emp, nowIso) {
  return {
    timezone: TZ,
    now: nowIso,
    employee: emp ? {
      id: emp.id || null,
      name: emp.name || "",
      email: emp.email || "",
      admin: !!emp.admin
    } : null,
    nextShift: null,
    pastShifts: [],
    thisWeek: { week: null, startsOn: null, endsOn: null, shiftCount: 0, scheduledHours: 0 },
    thisMonth: { month: null, scheduledHours: 0, actualHours: 0 },
    hoursNote: HOURS_NOTE,
    activity: []
  };
}

function buildHome(state, emp, now, options) {
  const clock = now instanceof Date ? now : new Date(now);
  if (!emp || !emp.id || isNaN(clock.getTime())) return emptyHome(emp, null);
  const onlyChannel = options && options.channelId || null;
  const access = accessFor(state, emp);
  if (onlyChannel && !access.implicit && !access.mine.has(onlyChannel)) {
    const blocked = emptyHome(emp, clock.toISOString());
    blocked.thisWeek.week = currentWeekKey(clock);
    blocked.thisMonth.month = currentMonthKey(clock);
    return blocked;
  }
  const weekKey = currentWeekKey(clock);
  const month = currentMonthKey(clock);
  const sunday = reminders.parseYmd(weekKey);
  const shifts = collectShifts(state, emp, access, onlyChannel);
  const nowMs = clock.getTime();
  let next = null;
  const past = [];
  let weekMinutes = 0;
  let weekCount = 0;
  let monthMinutes = 0;
  let actualMinutes = 0;
  for (const shift of shifts) {
    const ended = shift.endsMs <= nowMs;
    shift.status = ended ? "completed" : (shift.startsMs <= nowMs ? "in_progress" : "upcoming");
    if (shift.week === weekKey) {
      weekCount++;
      weekMinutes += shift.minutes;
    }
    if (shift.month === month) {
      monthMinutes += shift.minutes;
      if (ended) actualMinutes += shift.minutes;
    }
    if (!ended) {
      if (!next || shift.startsMs < next.startsMs
        || (shift.startsMs === next.startsMs && (shift.week < next.week
          || (shift.week === next.week && (shift.dayIdx < next.dayIdx
            || (shift.dayIdx === next.dayIdx && shift.shiftId < next.shiftId)))))) {
        next = shift;
      }
    } else {
      past.push(shift);
    }
  }
  past.sort((a, b) => {
    if (a.endsAt !== b.endsAt) return a.endsAt < b.endsAt ? 1 : -1;
    if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? 1 : -1;
    if (a.week !== b.week) return a.week < b.week ? 1 : -1;
    if (a.dayIdx !== b.dayIdx) return b.dayIdx - a.dayIdx;
    return a.shiftId < b.shiftId ? 1 : (a.shiftId > b.shiftId ? -1 : 0);
  });
  return {
    timezone: TZ,
    now: clock.toISOString(),
    employee: {
      id: emp.id,
      name: emp.name || "",
      email: emp.email || "",
      admin: !!emp.admin
    },
    nextShift: next ? publicShift(next) : null,
    pastShifts: past.slice(0, PAST_LIMIT).map(publicShift),
    thisWeek: {
      week: weekKey,
      startsOn: weekKey,
      endsOn: sunday ? reminders.formatYmd(reminders.addDays(sunday, 6)) : null,
      shiftCount: weekCount,
      scheduledHours: hoursFromMinutes(weekMinutes)
    },
    thisMonth: {
      month,
      scheduledHours: hoursFromMinutes(monthMinutes),
      actualHours: hoursFromMinutes(actualMinutes)
    },
    hoursNote: HOURS_NOTE,
    activity: activityRows(state, emp, access, onlyChannel)
  };
}

function copyPublished(wk, old) {
  const actor = old && old.publishedBy;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const name = String(actor.name || "").trim();
    const email = String(actor.email || "").trim();
    if (name || email) {
      wk.publishedBy = {
        id: actor.id ? String(actor.id) : null,
        name: name || email,
        email: email || null
      };
    } else delete wk.publishedBy;
  } else delete wk.publishedBy;
  if (old && typeof old.publishedAt === "string" && old.publishedAt) wk.publishedAt = old.publishedAt;
  else delete wk.publishedAt;
}

function clearPublished(wk) {
  delete wk.publishedBy;
  delete wk.publishedAt;
}

/* Stamp publishedBy / publishedAt when an admin flips a week to published.
   A later save that leaves it published keeps the original actor. A worker
   save cannot publish, unpublish, or rewrite those fields. Mutates nextWeeks. */
function attributePublishes(prevWeeks, nextWeeks, actor, nowIso, channels) {
  const events = [];
  const isAdmin = !!(actor && actor.admin);
  const access = {
    implicit: !(channels && channels.length),
    legacyId: null
  };
  if (!access.implicit) {
    const marked = channels.find(c => c && (c.default || c.id === "ch_default"));
    access.legacyId = marked ? marked.id : channels[0].id;
  }
  const prev = prevWeeks || {};
  for (const [key, wk] of Object.entries(nextWeeks || {})) {
    if (!wk || typeof wk !== "object" || Array.isArray(wk)) continue;
    const old = prev[key];
    const had = !!(old && typeof old === "object" && !Array.isArray(old));
    if (!isAdmin) {
      if (had) {
        wk.published = old.published === true;
        copyPublished(wk, old);
      } else {
        wk.published = false;
        clearPublished(wk);
      }
      continue;
    }
    if (wk.published !== true) {
      wk.published = false;
      clearPublished(wk);
      continue;
    }
    if (had && old.published === true) {
      copyPublished(wk, old);
      continue;
    }
    const name = String(actor.name || "").trim();
    const email = String(actor.email || "").trim();
    const publishedBy = {
      id: actor.id ? String(actor.id) : null,
      name: name || email,
      email: email || null
    };
    wk.publishedBy = publishedBy;
    wk.publishedAt = nowIso;
    events.push({
      key,
      week: weekDateOf(key),
      channelId: weekChannel(key, wk, access),
      publishedBy,
      publishedAt: nowIso
    });
  }
  return events;
}

module.exports = {
  TZ,
  PAST_LIMIT,
  ACTIVITY_LIMIT,
  HOURS_NOTE,
  shiftMinutes,
  publicActor,
  attributePublishes,
  buildHome
};
