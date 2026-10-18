import { $, esc, cached, hash, local, startOfDay, addDays, fmtTime, updatedText, errorText, colorVar, safeUrl } from './util.js';
import { graph } from './msauth.js';
import { gapi, googleAccount, googleConfigured } from './gauth.js';
import { BUILT_IN_HOSTS, msClientId } from './settings.js';
import { icon } from './icons.js';

const DAYS_AHEAD = 7;
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
  if (stored && !force && Date.now() - stored.at < 60 * 60e3) return stored.data;
  const me = await googleAccount();
  const items = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', fields: 'nextPageToken,items(id,summary,summaryOverride,backgroundColor,selected,primary)' });
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
    }))
    .sort((a, b) => b.primary - a.primary || b.selected - a.selected || a.name.localeCompare(b.name));
  await local.set('cache:gcal-list', { at: Date.now(), data });
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
        'nextPageToken,items(id,status,summary,location,htmlLink,hangoutLink,start,end,eventType,attendees(self,responseStatus),conferenceData(entryPoints(entryPointType,uri)))',
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
    $select: 'subject,start,end,isAllDay,isCancelled,location,webLink,onlineMeeting',
  });
  const data = await graph(clientId, `/me/calendarView?${q}`, { Prefer: 'outlook.timezone="UTC"' });
  return data.value
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
      };
    });
}

export async function refreshCalendars(S, force, onChange) {
  const from = startOfDay();
  const to = addDays(from, DAYS_AHEAD + 1);
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
      sig: hash([S.google.calendars, from]),
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
      sig: hash([cal.url, from]),
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
      sig: hash([msClientId(S), from]),
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

function allEvents() {
  const seen = new Set();
  return [...sources.values()]
    .flatMap((s) => s.events.map((e) => ({ ...e, color: s.cal.color, calName: s.cal.name })))
    .sort((a, b) => a.start - b.start || b.allDay - a.allDay || a.title.localeCompare(b.title))
    .filter((e) => {
      // The same invite often sits on two calendars; show it once.
      const k = `${e.title}|${e.start}|${e.end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export function nextUp() {
  const now = Date.now();
  const timed = allEvents().filter((e) => !e.allDay && e.end > now && e.start < now + 18 * 3600e3);
  const current = timed.filter((e) => e.start <= now).sort((a, b) => b.start - a.start)[0];
  const next = timed.find((e) => e.start > now);
  if (next && (!current || next.start - now < 15 * 60e3)) return { event: next, mode: 'next' };
  if (current) return { event: current, mode: 'now' };
  return null;
}

const dayUrl = (t) => {
  const d = new Date(t);
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const eventHref = (e) => safeUrl(e.link || dayUrl(e.start));
export { colorVar };
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

function timedRow(e, now, h24, { compact = false } = {}) {
  const state = e.end <= now ? 'past' : e.start <= now ? 'current' : '';
  const range = compact ? fmtTime(e.start, h24) : `${fmtTime(e.start, h24)}<span class="to">${fmtTime(e.end, h24)}</span>`;
  return `<li class="ev ${state}">
    <span class="ev-time">${range}</span>
    <div class="ev-main">
      <a class="ev-title" href="${esc(eventHref(e))}">${dot(e.color)}<span>${esc(e.title)}</span></a>
      ${!compact && e.location && !/^https?:/.test(e.location) ? `<span class="ev-where">${esc(e.location)}</span>` : ''}
    </div>
    ${state === 'current' ? '<span class="pill now-pill">Now</span>' : ''}
    ${!compact || state === 'current' ? joinButton(e) : ''}
  </li>`;
}

function allDayChips(list) {
  if (!list.length) return '';
  return `<div class="allday">${list
    .map((e) => `<a class="chip" href="${esc(eventHref(e))}" title="${esc(e.calName)}">${dot(e.color)}${esc(e.title)}</a>`)
    .join('')}</div>`;
}

export function renderAgenda(S) {
  const body = $('#today-body');
  if (!body) return;
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
  body.innerHTML = parts.join('') + notices.join('');
  const upcoming = body.querySelector('.upcoming');
  if (upcoming) upcoming.classList.toggle('scrolls', upcoming.scrollHeight > upcoming.clientHeight + 4);

  const legend = $('#today-legend');
  const shown = [
    ...[...sources.entries()].filter(([id]) => id.startsWith('g:')).map(([, s]) => s.cal),
    ...S.calendars.filter((c) => c.enabled && c.url),
    ...(outlookOn ? [{ name: 'Outlook', color: S.outlook.color }] : []),
  ];
  legend.innerHTML = shown.map((c) => `<span class="legend-item">${dot(c.color)}${esc(c.name)}</span>`).join('');
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
