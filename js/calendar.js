import { $, esc, cached, hash, local, startOfDay, addDays, fmtTime, updatedText, errorText, colorVar, safeUrl } from './util.js';
import { graph } from './msauth.js';
import { gapi, googleAccount, googleConfigured } from './gauth.js';
import { BUILT_IN_HOSTS, msClientId } from './settings.js';
import { icon, weatherIcon } from './icons.js';
import { describe } from './weather.js';
import { tripInfo, leaveText, tripSources } from './trip.js';

const DAYS_AHEAD = 7;

// First day of the week for this browser's locale (0 = Sunday).
const locale = new Intl.Locale(navigator.language || 'en-US');
export const FIRST_DAY = ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 7) % 7;

// The days a month view shows: from the week containing the 1st to the week containing the last day.
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = addDays(first.getTime(), -((first.getDay() - FIRST_DAY + 7) % 7));
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil(((first.getDay() - FIRST_DAY + 7) % 7 + daysInMonth) / 7);
  return { start, end: addDays(start, weeks * 7), weeks };
}

// Fetched on every refresh: this month's grid through next month's, which also covers the
// next seven days for the Today list.
function mainRange() {
  const now = new Date();
  const thisMonth = monthGrid(now.getFullYear(), now.getMonth());
  const nextMonth = monthGrid(now.getFullYear(), now.getMonth() + 1);
  return { from: Math.min(thisMonth.start, startOfDay()), to: Math.max(nextMonth.end, addDays(startOfDay(), DAYS_AHEAD + 1)) };
}
let range = mainRange();
const sources = new Map(); // calendar id -> { cal, events, at, error }

let worker;
let seq = 0;
const pending = new Map();

function expandIcs(text, from, to) {
  if (!worker) {
    worker = new Worker('js/ics-worker.js');
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.events);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, text, from, to });
  });
}

async function fetchIcs(url, from, to) {
  const res = await fetch(url.trim().replace(/^webcal:/i, 'https:'), { credentials: 'omit', cache: 'no-store' });
  if (res.status === 404 || res.status === 403) throw new Error('This calendar link no longer works. Paste a fresh one in Settings.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return expandIcs(await res.text(), from, to);
}

const JOIN_TEXT = /https:\/\/(?:[\w-]+\.)*(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)\/[^\s"'<>)\]]+/i;

const localDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

// The Google calendars on this account, with the names and colors Google Calendar shows.
export async function listGoogleCalendars(force = false) {
  const stored = await local.get('cache:gcal-list');
  // v2 added whether each calendar takes new events.
  if (stored?.v === 2 && !force && Date.now() - stored.at < 60 * 60e3) return stored.data;
  const me = await googleAccount();
  const items = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', fields: 'nextPageToken,items(id,summary,summaryOverride,backgroundColor,selected,primary,accessRole)' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gapi(`/calendar/v3/users/me/calendarList?${q}`);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  const data = items
    .map((c) => ({
      id: c.id,
      name: c.primary ? me?.name || 'My calendar' : c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || '#4285f4',
      primary: Boolean(c.primary),
      selected: Boolean(c.selected || c.primary),
      writable: ['owner', 'writer', 'writerWithoutPrivateAccess'].includes(c.accessRole),
    }))
    .sort((a, b) => b.primary - a.primary || b.selected - a.selected || a.name.localeCompare(b.name));
  await local.set('cache:gcal-list', { v: 2, at: Date.now(), data });
  return data;
}

export const shownGoogleCalendars = (S, list) =>
  list.filter((c) => (Array.isArray(S.google.calendars) ? S.google.calendars.includes(c.id) : c.selected));

async function fetchGoogleEvents(cal, from, to) {
  const events = [];
  let pageToken = '';
  let pages = 0;
  do {
    const q = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      maxResults: '250',
      maxAttendees: '1',
      fields:
        'nextPageToken,items(id,status,summary,location,htmlLink,hangoutLink,start,end,eventType,recurringEventId,guestsCanModify,organizer(self,email),attendees(self,responseStatus),conferenceData(entryPoints(entryPointType,uri)))',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gapi(`/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
    for (const e of page.items || []) {
      if (e.status === 'cancelled' || e.eventType === 'workingLocation') continue;
      if (e.attendees?.find((a) => a.self)?.responseStatus === 'declined') continue;
      const allDay = Boolean(e.start?.date);
      const start = allDay ? localDate(e.start.date) : Date.parse(e.start?.dateTime);
      const end = allDay ? localDate(e.end?.date || e.start.date) : Date.parse(e.end?.dateTime || e.start?.dateTime);
      if (!Number.isFinite(start)) continue;
      events.push({
        id: e.id,
        title: e.summary || (e.eventType === 'outOfOffice' ? 'Out of office' : 'Busy'),
        start,
        end: allDay && end <= start ? start + 86400000 : end,
        allDay,
        location: (e.location || '').slice(0, 140),
        join: e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || e.hangoutLink || (e.location || '').match(JOIN_TEXT)?.[0] || '',
        link: e.htmlLink,
        // Where it lives, so its details can be opened and (on a calendar you can edit) changed.
        src: 'google',
        calId: cal.id,
        // Someone else's invite can only be changed by them, unless they let guests edit.
        editable: Boolean(cal.writable) && e.eventType !== 'outOfOffice' && Boolean(e.organizer?.self || e.organizer?.email === cal.id || e.guestsCanModify),
        recurring: Boolean(e.recurringEventId),
      });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken && ++pages < 4);
  return events;
}

async function fetchOutlookCalendar(clientId, from, to) {
  const q = new URLSearchParams({
    startDateTime: new Date(from).toISOString(),
    endDateTime: new Date(to).toISOString(),
    $top: '250',
    $orderby: 'start/dateTime',
    $select: 'subject,start,end,isAllDay,isCancelled,location,webLink,onlineMeeting,type,isOrganizer',
  });
  const items = [];
  let next = `/me/calendarView?${q}`;
  for (let page = 0; next && page < 4; page++) {
    const data = await graph(clientId, next, { Prefer: 'outlook.timezone="UTC"' });
    items.push(...(data.value || []));
    next = data['@odata.nextLink'];
  }
  return items
    .filter((e) => !e.isCancelled)
    .map((e) => {
      const parse = (v) => {
        if (!e.isAllDay) return Date.parse(v.dateTime + 'Z');
        const [y, m, d] = v.dateTime.slice(0, 10).split('-').map(Number);
        return new Date(y, m - 1, d).getTime();
      };
      return {
        id: e.id,
        title: e.subject || '(No title)',
        start: parse(e.start),
        end: parse(e.end),
        allDay: e.isAllDay,
        location: e.location?.displayName || '',
        join: e.onlineMeeting?.joinUrl || '',
        link: e.webLink,
        src: 'outlook',
        editable: e.isOrganizer !== false,
        recurring: e.type === 'occurrence' || e.type === 'exception',
      };
    });
}

export async function refreshCalendars(S, force, onChange) {
  settingsRef = S;
  range = mainRange();
  const { from, to } = range;
  const wanted = new Set();
  const update = (cal) => (events, meta) => {
    sources.set(cal.id, { cal, events: events || [], ...meta });
    onChange();
  };
  googleState = googleConfigured() ? ((await googleAccount()) ? 'connected' : 'off') : 'unavailable';
  if (googleState !== 'connected') googleError = null;
  if (googleState === 'connected') {
    wanted.add('google');
    cached({
      key: 'gcal',
      sig: hash([S.google.calendars, from, 'v2']),
      maxAge: 5 * 60e3,
      force,
      fetch: async () => {
        const shown = shownGoogleCalendars(S, await listGoogleCalendars(force));
        const settled = await Promise.allSettled(shown.map((cal) => fetchGoogleEvents(cal, from, to)));
        if (shown.length && settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
        return settled.map((r, i) => ({ cal: shown[i], events: r.status === 'fulfilled' ? r.value : [], failed: r.status === 'rejected' }));
      },
      render: (results, meta) => {
        for (const id of sources.keys()) if (id.startsWith('g:')) sources.delete(id);
        for (const { cal, events, failed } of results || [])
          sources.set(`g:${cal.id}`, { cal, events, ...meta, error: failed ? new Error('couldn’t load this calendar right now') : null });
        googleError = meta.error || null;
        googleAt = meta.at;
        onChange();
      },
    });
  }
  for (const cal of S.calendars) {
    if (!cal.enabled || !cal.url) continue;
    wanted.add(cal.id);
    cached({
      key: `cal:${cal.id}`,
      sig: hash([cal.url, from, 'v2']),
      maxAge: 10 * 60e3,
      force,
      fetch: () => fetchIcs(cal.url, from, to),
      render: update(cal),
    });
  }
  outlookOn = Boolean(msClientId(S) && S.outlook.calendar && (await local.get('ms:auth')));
  if (outlookOn) {
    const cal = { id: 'outlook', name: 'Outlook', color: S.outlook.color };
    wanted.add(cal.id);
    cached({
      key: 'cal:outlook',
      sig: hash([msClientId(S), from, 'v2']),
      maxAge: 5 * 60e3,
      force,
      fetch: () => fetchOutlookCalendar(msClientId(S), from, to),
      render: update(cal),
    });
  }
  for (const id of sources.keys()) if (!wanted.has(id) && !(id.startsWith('g:') && wanted.has('google'))) sources.delete(id);
  onChange();
}

let googleState = 'off';
let googleError = null;
let googleAt = 0;
let outlookOn = false;

const dedupe = (list) => {
  const seen = new Set();
  return list
    .sort((a, b) => a.start - b.start || b.allDay - a.allDay || a.title.localeCompare(b.title))
    .filter((e) => {
      // The same invite often sits on two calendars; show it once.
      const k = `${e.title}|${e.start}|${e.end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
};

// Events just added here, shown until the calendar's next refresh brings them in.
let justAdded = [];

export function addPendingEvent(e) {
  justAdded = [...justAdded.filter((p) => p.id !== e.id), { ...e, until: Date.now() + 5 * 60e3 }];
}

export function removePendingEvent(id) {
  justAdded = justAdded.filter((p) => p.id !== id);
}

// Events just deleted here (Undo), kept off screen even if a refresh that started before the
// delete still brings them back.
const justRemoved = new Map(); // event id -> until

export function forgetEvent(id) {
  justRemoved.set(id, Date.now() + 5 * 60e3);
}

// Events just changed here, shown with the new details until the calendar has caught up.
const justEdited = new Map(); // event id -> { changes, until }

export function editPendingEvent(id, changes) {
  if (changes) justEdited.set(id, { changes, until: Date.now() + 5 * 60e3 });
  else justEdited.delete(id);
}

const withEdits = (list) => {
  if (!justEdited.size) return list;
  const now = Date.now();
  for (const [id, { until }] of justEdited) if (until < now) justEdited.delete(id);
  return list.map((e) => (justEdited.has(e.id) ? { ...e, ...justEdited.get(e.id).changes } : e));
};

export function allEvents() {
  const now = Date.now();
  justAdded = justAdded.filter((p) => p.until > now);
  for (const [id, until] of justRemoved) if (until < now) justRemoved.delete(id);
  const all = [...sources.values()].flatMap((s) => s.events.map((e) => ({ ...e, color: s.cal.color, calName: s.cal.name }))).concat(justAdded);
  return dedupe(withEdits(justRemoved.size ? all.filter((e) => !justRemoved.has(e.id)) : all));
}

// ---- Months outside the regular window (loaded when the month view flips to them) ----

const extraMonths = new Map(); // 'YYYY-M' -> { events, at, loading }
let settingsRef = null;

async function fetchAllRange(S, from, to) {
  const out = [];
  const decorate = (cal) => (events) => out.push(...events.map((e) => ({ ...e, color: cal.color, calName: cal.name })));
  const jobs = [];
  if (googleState === 'connected') {
    jobs.push(
      listGoogleCalendars().then((list) =>
        Promise.allSettled(shownGoogleCalendars(S, list).map((cal) => fetchGoogleEvents(cal, from, to).then(decorate(cal)))),
      ),
    );
  }
  for (const cal of S.calendars) if (cal.enabled && cal.url) jobs.push(fetchIcs(cal.url, from, to).then(decorate(cal)));
  if (outlookOn) {
    const cal = { name: 'Outlook', color: S.outlook.color };
    jobs.push(fetchOutlookCalendar(msClientId(S), from, to).then(decorate(cal)));
  }
  await Promise.allSettled(jobs);
  return out;
}

const monthKey = (year, month) => {
  const d = new Date(year, month, 1);
  return `${d.getFullYear()}-${d.getMonth()}`;
};

// Makes sure a month's events are available. Returns true when they are already here;
// otherwise starts loading them and calls onLoaded when done.
export function ensureMonth(year, month, onLoaded) {
  const { start, end } = monthGrid(year, month);
  if (start >= range.from && end <= range.to) return true;
  const key = monthKey(year, month);
  const have = extraMonths.get(key);
  if (have?.loading) return false;
  if (have && Date.now() - have.at < 30 * 60e3) return true;
  if (!settingsRef) return true;
  extraMonths.set(key, { loading: true, events: have?.events || [] });
  const gen = monthsGen;
  fetchAllRange(settingsRef, start, end).then((events) => {
    // Calendars changed (an event added or undone) while this was loading: it's out of date.
    if (gen !== monthsGen) return;
    extraMonths.set(key, { events, at: Date.now() });
    onLoaded();
  });
  return false;
}

// Calendars a new event can go on: Google calendars you can edit (the ones shown here first)
// and Outlook's main calendar, which is the one Daybook shows.
export async function writableCalendars(S) {
  const list = [];
  let error = null;
  if (googleConfigured() && (await googleAccount())) {
    try {
      const all = await listGoogleCalendars();
      const shown = new Set(shownGoogleCalendars(S, all).map((c) => c.id));
      for (const c of all.filter((c) => c.writable).sort((a, b) => shown.has(b.id) - shown.has(a.id)))
        list.push({ kind: 'google', id: c.id, name: c.name, color: c.color, primary: c.primary, shown: shown.has(c.id) });
    } catch (err) {
      error = err;
    }
  }
  const auth = msClientId(S) && S.outlook.calendar ? await local.get('ms:auth') : null;
  if (auth) list.push({ kind: 'outlook', id: 'outlook', name: 'Outlook', detail: auth.account || '', color: S.outlook.color, shown: true });
  return { list, error };
}

// After adding or removing an event: months outside the regular window load again.
let monthsGen = 0;
export function calendarsChanged() {
  monthsGen++;
  extraMonths.clear();
}

export function eventsBetween(from, to) {
  const extra = withEdits([...extraMonths.values()].flatMap((m) => m.events).filter((e) => !justRemoved.has(e.id)));
  return dedupe([...allEvents(), ...extra]).filter((e) => e.end > from && e.start < to);
}

export function nextUp() {
  const now = Date.now();
  const timed = allEvents().filter((e) => !e.allDay && e.end > now && e.start < now + 18 * 3600e3);
  const current = timed.filter((e) => e.start <= now).sort((a, b) => b.start - a.start)[0];
  // Next is whatever needs you first: the next to start, or one you have to leave for earlier.
  const due = (e) => Math.min(e.start, tripInfo(e)?.leave?.at || Infinity);
  const next = timed.filter((e) => e.start > now).sort((a, b) => due(a) - due(b))[0];
  // Mid-meeting, the next event takes over 15 minutes before it starts, or before you need to leave.
  if (next && (!current || due(next) - now < 15 * 60e3)) return { event: next, mode: 'next' };
  if (current) return { event: current, mode: 'now' };
  return null;
}

const dayUrl = (t) => {
  const d = new Date(t);
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
export const eventHref = (e) => safeUrl(e.link || dayUrl(e.start));
export { colorVar };

// Events on screen by a key in their markup, so a click can open the one it was on.
const onScreen = new Map();
export const shownEvent = (key) => onScreen.get(key);
function eventKey(e) {
  const k = hash([e.id, e.start, e.calName]);
  onScreen.set(k, e);
  return k;
}
const dot = (color) => `<span class="cal-dot" style="--c: ${colorVar(color)}"></span>`;

function joinButton(e) {
  return e.join
    ? `<a class="join" href="${esc(safeUrl(e.join))}" title="Join the video call">${icon('video')}<span>Join</span></a>`
    : '';
}

function ruler(timed, today, now, h24) {
  if (!timed.length) return '';
  const hours = timed.map((e) => [new Date(Math.max(e.start, today)).getHours(), Math.min(24, (Math.min(e.end, today + 86400e3) - today) / 3600e3)]);
  const h0 = Math.min(8, ...hours.map(([s]) => s));
  const h1 = Math.max(22, ...hours.map(([, e]) => Math.ceil(e)));
  const pos = (t) => Math.min(100, Math.max(0, (((t - today) / 3600e3 - h0) / (h1 - h0)) * 100));
  const lanes = [];
  const blocks = timed.map((e) => {
    let lane = lanes.findIndex((end) => end <= e.start);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = e.end;
    return { e, lane };
  });
  const ticks = [];
  for (let h = Math.ceil(h0 / 3) * 3; h <= h1; h += 3) {
    const t = today + h * 3600e3;
    const label = h24 ? String(h % 24).padStart(2, '0') : h % 12 === 0 ? (h % 24 === 0 ? '12a' : '12p') : `${h % 12}${h < 12 ? 'a' : 'p'}`;
    ticks.push(`<span class="tick" style="left:${pos(t)}%">${label}</span>`);
  }
  const nowMark = now >= today + h0 * 3600e3 && now <= today + h1 * 3600e3 ? `<span class="ruler-now" style="left:${pos(now)}%"></span>` : '';
  return `<div class="ruler" style="--lanes:${lanes.length}" aria-hidden="true">
    <div class="ruler-track">${blocks
      .map(
        ({ e, lane }) =>
          `<span class="ruler-block${e.end <= now ? ' past' : ''}" title="${esc(fmtTime(e.start, h24) + '  ' + e.title)}" style="--c: ${colorVar(e.color)}; left:${pos(e.start)}%; width:${Math.max(0.8, pos(e.end) - pos(e.start))}%; top:${lane * 9}px"></span>`,
      )
      .join('')}${nowMark}</div>
    <div class="ruler-ticks">${ticks.join('')}</div>
  </div>`;
}

// The forecast at the event's place and time, and when to leave to get there.
export function tripLine(e, state, h24) {
  const t = state === 'past' ? null : tripInfo(e);
  if (!t) return '';
  const bits = [];
  if (t.wx) {
    const { label, glyph } = describe(t.wx.code, t.wx.isDay);
    const temp = Math.round(t.wx.temp);
    bits.push(
      `<span class="ev-wx" title="${esc(`${label}, ${temp}° at ${fmtTime(e.start, h24)}${t.wx.pop >= 20 ? `, ${t.wx.pop}% chance of rain` : ''}`)}">${weatherIcon(glyph)}${temp}°${t.wx.pop >= 20 ? `<span class="ev-pop">${icon('drop', 'drop')}${t.wx.pop}%</span>` : ''}</span>`,
    );
  }
  if (t.leave && !state) {
    const { text, level } = leaveText(t.leave, (ms) => fmtTime(ms, h24));
    const how = !t.leave.traffic ? 'without traffic' : t.leave.live ? 'with current traffic' : 'with typical traffic for then';
    bits.push(`<span class="ev-leave${level ? ` ${level}` : ''}" title="${esc(`About ${t.leave.mins} min drive ${how}`)}">${icon('car')}${esc(text)}<span class="ev-drive"> · ${t.leave.mins} min</span></span>`);
  }
  return bits.length ? `<span class="ev-extra">${bits.join('')}</span>` : '';
}

export function timedRow(e, now, h24, { compact = false } = {}) {
  const state = e.end <= now ? 'past' : e.start <= now ? 'current' : '';
  const range = compact ? fmtTime(e.start, h24) : `${fmtTime(e.start, h24)}<span class="to">${fmtTime(e.end, h24)}</span>`;
  return `<li class="ev ${state}">
    <span class="ev-time">${range}</span>
    <div class="ev-main">
      <button class="ev-title" type="button" data-event="${eventKey(e)}" aria-haspopup="dialog">${dot(e.color)}<span>${esc(e.title)}</span></button>
      ${!compact && e.location && !/^https?:/.test(e.location) ? `<span class="ev-where">${esc(e.location)}</span>` : ''}
      ${tripLine(e, state, h24)}
    </div>
    ${state === 'current' ? '<span class="pill now-pill">Now</span>' : ''}
    ${!compact || state === 'current' ? joinButton(e) : ''}
  </li>`;
}

export function allDayChips(list) {
  if (!list.length) return '';
  return `<div class="allday">${list
    .map((e) => `<button class="chip" type="button" data-event="${eventKey(e)}" aria-haspopup="dialog" title="${esc(e.calName)}">${dot(e.color)}${esc(e.title)}</button>`)
    .join('')}</div>`;
}

export function renderAgenda(S) {
  const body = $('#today-body');
  if (!body) return;
  // The month view draws right after this and adds its own.
  onScreen.clear();
  const now = Date.now();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const h24 = S.clock24;
  const events = allEvents();
  $('#today-date').textContent = new Date(now).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const configured = googleState === 'connected' || S.calendars.some((c) => c.enabled && c.url) || outlookOn;
  const parts = [];

  if (configured) {
    const todayAll = events.filter((e) => e.allDay && e.start < tomorrow && e.end > today);
    const todayTimed = events.filter((e) => !e.allDay && e.start < tomorrow && e.end > today);
    parts.push(ruler(todayTimed, today, now, h24));
    parts.push(allDayChips(todayAll));
    const remaining = todayTimed.filter((e) => e.end > now).length;
    parts.push(
      todayTimed.length
        ? `<ol class="ev-list">${todayTimed.map((e) => timedRow(e, now, h24)).join('')}</ol>${remaining ? '' : '<p class="quiet">That was everything today.</p>'}`
        : `<p class="quiet">${todayAll.length ? 'No timed events today.' : 'Nothing on the calendar today.'}</p>`,
    );

    const days = [];
    for (let i = 1; i <= DAYS_AHEAD - 1; i++) {
      const d0 = addDays(today, i);
      const d1 = addDays(today, i + 1);
      const allDay = events.filter((e) => e.allDay && e.start < d1 && e.end > d0);
      const timed = events.filter((e) => !e.allDay && e.start >= d0 && e.start < d1);
      if (!allDay.length && !timed.length) continue;
      const label = i === 1 ? 'Tomorrow' : new Date(d0).toLocaleDateString(undefined, { weekday: 'long' });
      const date = new Date(d0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      days.push(`<section class="day">
        <h3><span>${label}</span><span class="day-date">${date}</span></h3>
        ${allDayChips(allDay)}
        ${timed.length ? `<ol class="ev-list compact">${timed.map((e) => timedRow(e, now, h24, { compact: true })).join('')}</ol>` : ''}
      </section>`);
    }
    parts.push(
      days.length
        ? `<div class="upcoming"><h3 class="eyebrow">Coming up</h3>${days.join('')}</div>`
        : '<div class="upcoming"><h3 class="eyebrow">Coming up</h3><p class="quiet">Nothing scheduled for the rest of the week.</p></div>',
    );
  }

  const notices = [];
  if (googleError) {
    notices.push(
      googleError.code === 'needs-google'
        ? `<div class="notice warn"><p>${esc(googleError.message)}.</p><button class="btn small" type="button" data-open-settings="accounts">Reconnect Google</button></div>`
        : `<p class="notice warn">Google Calendar: ${esc(errorText(googleError))}.${googleAt ? ` Showing the copy from ${updatedText(googleAt).replace('updated ', '')}.` : ''}</p>`,
    );
  }
  for (const [id, { cal, error, at }] of sources) {
    if (error && (!id.startsWith('g:') || !googleError)) notices.push(`<p class="notice warn">${esc(cal.name)}: ${esc(errorText(error))}${at ? ` Showing the copy from ${updatedText(at).replace('updated ', '')}.` : ''}</p>`);
  }
  for (const cal of S.calendars) {
    if (cal.enabled && !cal.url) notices.push(`<p class="notice warn">${esc(cal.name)} has no iCal link yet. <button class="linklike" type="button" data-open-settings="calendars">Add it in Settings</button>.</p>`);
  }
  if (!configured) {
    notices.push(
      googleState === 'unavailable'
        ? `<div class="notice setup"><p>Add a calendar’s iCal link to see your day here.</p><button class="btn small primary" type="button" data-open-settings="calendars">Add a calendar</button></div>`
        : `<div class="notice setup"><p>Connect Google or Outlook to see your day here.</p><button class="btn small primary" type="button" data-open-settings="accounts">Connect a calendar</button></div>`,
    );
  }
  const trips = tripSources();
  const credit = trips.places
    ? [
        'Places © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        trips.osrm && 'drive times by <a href="https://routing.openstreetmap.de/">FOSSGIS OSRM</a>',
        trips.tomtom && 'traffic by <a href="https://www.tomtom.com/">TomTom</a>',
        trips.weather && !S.show.weather && 'weather by <a href="https://open-meteo.com/">Open-Meteo.com</a>',
      ].filter(Boolean)
    : [];
  body.innerHTML = parts.join('') + notices.join('') + (configured && credit.length ? `<p class="credit">${credit.join(' · ')}</p>` : '');
  const upcoming = body.querySelector('.upcoming');
  if (upcoming) upcoming.classList.toggle('scrolls', upcoming.scrollHeight > upcoming.clientHeight + 4);

  const ats = [...sources.values()].map((s) => s.at).filter(Boolean);
  $('#today-updated').textContent = ats.length ? updatedText(Math.min(...ats)) : '';
}

// Hosts a calendar list needs beyond what the manifest grants.
export const extraOrigins = (urls) =>
  urls
    .map((u) => {
      try {
        const url = new URL(u.trim().replace(/^webcal:/i, 'https:'));
        return BUILT_IN_HOSTS.includes(url.hostname) ? null : `${url.protocol}//${url.hostname}/*`;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
