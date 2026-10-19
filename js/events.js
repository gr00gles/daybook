// Adding an event: a small form for the title, time, place and which calendar it goes on.
// Google calendars get it through the Calendar API and Outlook through Microsoft Graph; the
// first time, each asks for permission to add events. Undo deletes it again.
import { $, esc, local, colorVar, showToast, errorText, startOfDay, addDays } from './util.js';
import { writableCalendars, calendarsChanged, addPendingEvent, removePendingEvent, forgetEvent } from './calendar.js';
import { calendarWrite } from './gauth.js';
import { graph, graphWrite } from './msauth.js';
import { msClientId } from './settings.js';
import { openSettings } from './sheet.js';
import { icon } from './icons.js';

const LAST_KEY = 'event:lastCal';
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let settingsRef;
let onChange = () => {};
let cals = [];
let busy = false;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// A local date ("2026-10-19") and time ("14:30") as a moment.
const at = (date, time = '00:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0).getTime();
};

// Local time with its UTC offset, which is what Google expects: 2026-10-19T14:30:00-04:00.
function rfc3339(t) {
  const off = -new Date(t).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${ymd(t)}T${hm(t)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const calKey = (c) => `${c.kind}:${c.id}`;
// An error as the end of a sentence we write ("Couldn’t add the event: …."), without "..".
const reason = (err) => errorText(err).replace(/[.\s]+$/, '');

// Today: the next half hour. Another day: 9 to 10 in the morning.
function startFor(day) {
  if (day != null && startOfDay(day) !== startOfDay()) return at(ymd(day), '09:00');
  const d = new Date(Date.now() + 5 * 60e3);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  if (m > 30) d.setMinutes(60);
  else if (m > 0) d.setMinutes(30);
  return d.getTime();
}

function form(start, last) {
  const end = start + 3600e3;
  const options = cals.length
    ? ['google', 'outlook']
        .map((kind) => {
          const group = cals.filter((c) => c.kind === kind);
          if (!group.length) return '';
          const opts = group
            .map((c) => {
              const label = c.kind === 'outlook' ? `Outlook${c.detail ? ` · ${c.detail}` : ''}` : `${c.name}${c.shown ? '' : ' (not shown in Daybook)'}`;
              return `<option value="${esc(calKey(c))}"${calKey(c) === last ? ' selected' : ''}>${esc(label)}</option>`;
            })
            .join('');
          return `<optgroup label="${kind === 'google' ? 'Google' : 'Outlook'}">${opts}</optgroup>`;
        })
        .join('')
    : '';
  return `<form class="ev-form" id="ev-form" novalidate>
    <header class="ev-form-head">
      <h2 id="ev-h">New event</h2>
      <button class="icon-btn" type="button" data-ev="cancel" aria-label="Close">${icon('close')}</button>
    </header>
    <label class="field"><span>Title</span><input id="ev-title" type="text" maxlength="300" placeholder="Add a title" autocomplete="off"></label>
    <label class="field"><span>Calendar</span>
      <span class="ev-cal"><span class="cal-dot" id="ev-cal-dot"></span><select id="ev-cal">${options}</select></span>
    </label>
    <label class="check"><input type="checkbox" id="ev-allday"><span>All day</span></label>
    <div class="ev-when">
      <label class="field"><span>Starts</span><input id="ev-start-date" type="date" value="${ymd(start)}" required></label>
      <label class="field ev-clock"><span>Start time</span><input id="ev-start-time" type="time" step="300" value="${hm(start)}"></label>
      <label class="field"><span>Ends</span><input id="ev-end-date" type="date" value="${ymd(end)}" required></label>
      <label class="field ev-clock"><span>End time</span><input id="ev-end-time" type="time" step="300" value="${hm(end)}"></label>
    </div>
    <label class="field"><span>Location</span><input id="ev-location" type="text" maxlength="300" placeholder="Address or place (optional)" autocomplete="off" list="ev-places"><datalist id="ev-places"></datalist></label>
    <label class="check" id="ev-meet-row"><input type="checkbox" id="ev-meet"><span>Add a Google Meet video call</span></label>
    <label class="field"><span>Notes</span><textarea id="ev-notes" rows="3" maxlength="4000" placeholder="Optional"></textarea></label>
    <div class="ev-error" id="ev-error" role="alert" hidden></div>
    <footer class="ev-form-foot">
      <button class="btn" type="button" data-ev="cancel">Cancel</button>
      <button class="btn primary" type="submit" id="ev-save">Add event</button>
    </footer>
  </form>`;
}

function noCalendars(error) {
  return `<div class="ev-form">
    <header class="ev-form-head">
      <h2 id="ev-h">New event</h2>
      <button class="icon-btn" type="button" data-ev="cancel" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="notice setup">
      <p>${error ? `Your Google calendars didn’t load: ${esc(reason(error))}.` : 'Connect Google or Outlook to add events from here. Calendars added by iCal link can only be read.'}</p>
      <button class="btn small primary" type="button" data-ev="settings">Open Settings</button>
    </div>
  </div>`;
}

const field = (id) => $(`#${id}`);

function selectedCal() {
  return cals.find((c) => calKey(c) === field('ev-cal')?.value) || null;
}

function paintCal() {
  const c = selectedCal();
  field('ev-cal-dot').style.setProperty('--c', colorVar(c?.color));
  field('ev-meet-row').hidden = c?.kind !== 'google';
}

function paintAllDay() {
  const allDay = field('ev-allday').checked;
  for (const el of document.querySelectorAll('#ev-form .ev-clock')) el.hidden = allDay;
  field('ev-form').classList.toggle('all-day', allDay);
}

function showError(html) {
  const box = field('ev-error');
  box.innerHTML = html;
  box.hidden = !html;
}

// The form's values as moments. For all-day events, end is the last day (inclusive).
function read() {
  const allDay = field('ev-allday').checked;
  const sd = field('ev-start-date').value;
  const ed = field('ev-end-date').value || sd;
  const st = field('ev-start-time').value;
  const et = field('ev-end-time').value;
  return {
    startTime: st,
    endTime: et,
    title: field('ev-title').value.trim(),
    allDay,
    startDate: sd,
    endDate: ed,
    // An empty or half-typed time reads as ''; that's a missing time, not midnight.
    start: sd && (allDay || st) ? at(sd, allDay ? '00:00' : st) : NaN,
    end: ed && (allDay || et) ? at(ed, allDay ? '00:00' : et) : NaN,
    location: field('ev-location').value.trim(),
    notes: field('ev-notes').value.trim(),
    meet: !field('ev-meet-row').hidden && field('ev-meet').checked,
  };
}

// Moving the start keeps the event's length, the way calendar apps do.
let lastStart = null;
let lastEnd = null;
function keepLength(changedStart) {
  const d = read();
  if (changedStart && Number.isFinite(lastStart) && Number.isFinite(lastEnd) && Number.isFinite(d.start)) {
    if (d.allDay) {
      // Whole days, counted on the calendar so a clock change can't shift the date.
      const days = Math.max(0, Math.round((lastEnd - lastStart) / 86400e3));
      field('ev-end-date').value = ymd(addDays(d.start, days));
    } else {
      const end = d.start + Math.max(15 * 60e3, lastEnd - lastStart);
      field('ev-end-date').value = ymd(end);
      field('ev-end-time').value = hm(end);
    }
  }
  const now = read();
  lastStart = now.start;
  lastEnd = now.end;
}

async function addGoogle(cal, d) {
  const body = {
    summary: d.title,
    location: d.location || undefined,
    description: d.notes || undefined,
    start: d.allDay ? { date: d.startDate } : { dateTime: rfc3339(d.start), timeZone: ZONE },
    // All-day events end the morning after their last day.
    end: d.allDay ? { date: ymd(addDays(at(d.endDate), 1)) } : { dateTime: rfc3339(d.end), timeZone: ZONE },
  };
  if (d.meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  const path = `/calendars/${encodeURIComponent(cal.id)}/events`;
  const ev = await calendarWrite(`${path}${d.meet ? '?conferenceDataVersion=1' : ''}`, { body });
  return {
    id: ev.id,
    link: ev.htmlLink,
    join: ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || '',
    remove: () => calendarWrite(`${path}/${encodeURIComponent(ev.id)}`, { method: 'DELETE' }),
  };
}

// The UTC offset of a time zone at a moment, like "GMT-04:00".
const offsetIn = (zone, t) =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value;

// Outlook accepts only some time zone names. Use yours if it's one of them, else one that
// keeps the same clock as yours on the event's days.
async function outlookZone(clientId, days) {
  let names = (await local.get('ms:zones'))?.names;
  if (!names) {
    try {
      const r = await graph(clientId, "/me/outlook/supportedTimeZones(TimeZoneStandard=microsoft.graph.timeZoneStandard'Iana')");
      names = (r.value || []).map((z) => z.alias).filter(Boolean);
      await local.set('ms:zones', { at: Date.now(), names });
    } catch {
      return ZONE;
    }
  }
  if (!names.length || names.includes(ZONE)) return ZONE;
  const same = names.find((z) => {
    try {
      return days.every((t) => offsetIn(z, t) === offsetIn(ZONE, t));
    } catch {
      return false;
    }
  });
  return same || ZONE;
}

async function addOutlook(d) {
  const clientId = msClientId(settingsRef);
  // Timed events go in as UTC, which can't be misread; all-day events need midnight in your
  // own time zone so they cover the right days.
  const zone = d.allDay ? await outlookZone(clientId, [at(d.startDate), addDays(at(d.endDate), 1)]) : 'UTC';
  const when = (t) => (d.allDay ? { dateTime: `${ymd(t)}T00:00:00`, timeZone: zone } : { dateTime: new Date(t).toISOString().slice(0, 19), timeZone: 'UTC' });
  const body = {
    subject: d.title,
    isAllDay: d.allDay,
    start: when(d.start),
    end: when(d.allDay ? addDays(at(d.endDate), 1) : d.end),
    location: d.location ? { displayName: d.location } : undefined,
    body: d.notes ? { contentType: 'text', content: d.notes } : undefined,
  };
  const ev = await graphWrite(clientId, '/me/events', { body, need: 'Calendars.ReadWrite' });
  return {
    id: ev.id,
    link: ev.webLink,
    join: ev.onlineMeeting?.joinUrl || '',
    remove: () => graphWrite(clientId, `/me/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE', need: 'Calendars.ReadWrite' }),
  };
}

function problem(d, cal) {
  if (!d.title) return 'Give the event a title.';
  if (!cal) return 'Pick a calendar.';
  if (!d.startDate) return 'Pick a start date.';
  if (!d.allDay && !d.startTime) return 'Pick a start time.';
  if (!d.endDate) return 'Pick an end date.';
  if (!d.allDay && !d.endTime) return 'Pick an end time.';
  if (!Number.isFinite(d.start) || !Number.isFinite(d.end)) return 'Check the dates and times.';
  if (d.allDay ? d.end < d.start : d.end <= d.start) return 'The event has to end after it starts.';
  return '';
}

async function save(dlg) {
  if (busy) return;
  const d = read();
  const cal = selectedCal();
  const why = problem(d, cal);
  if (why) {
    showError(`<p>${esc(why)}</p>`);
    if (!d.title) field('ev-title').focus();
    return;
  }
  busy = true;
  const btn = field('ev-save');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  showError('');
  try {
    const made = cal.kind === 'google' ? await addGoogle(cal, d) : await addOutlook(d);
    await local.set(LAST_KEY, calKey(cal));
    dlg.close();
    const end = d.allDay ? addDays(at(d.endDate), 1) : d.end;
    if (cal.shown) addPendingEvent({ id: `new:${made.id}`, title: d.title, start: d.start, end, allDay: d.allDay, location: d.location, join: made.join, link: made.link, color: cal.color, calName: cal.name });
    calendarsChanged();
    onChange();
    showToast(`Added to ${cal.kind === 'outlook' ? 'Outlook' : cal.name}`, async () => {
      try {
        await made.remove();
        removePendingEvent(`new:${made.id}`);
        forgetEvent(made.id);
        calendarsChanged();
        onChange();
        showToast('Event removed');
      } catch (err) {
        showToast(`Couldn’t remove it: ${reason(err)}.`);
      }
    });
  } catch (err) {
    if (err.code === 'needs-admin')
      showError(`<p>Your organization needs to approve Daybook adding events to your calendar.</p><p><a href="${esc(err.adminUrl)}" target="_blank" rel="noopener">Approval link to send to your IT team</a></p>`);
    else if (err.code === 'needs-google' || err.code === 'needs-connect')
      showError(`<p>${esc(reason(err))}. Reconnect in Settings → Accounts, then try again.</p>`);
    else showError(`<p>Couldn’t add the event: ${esc(reason(err))}.</p>`);
  } finally {
    busy = false;
    if (dlg.open) {
      btn.disabled = false;
      btn.textContent = 'Add event';
    }
  }
}

// Opens the form. `day` (a local midnight) prefills the date, e.g. from the month calendar.
export async function openEventEditor({ day } = {}) {
  const dlg = $('#event-dialog');
  // While a save is waiting (on a permission window, say), the form stays as it is.
  if (!dlg || dlg.open || busy) return;
  let error = null;
  try {
    ({ list: cals, error } = await writableCalendars(settingsRef));
  } catch (err) {
    cals = [];
    error = err;
  }
  if (!cals.length) {
    dlg.innerHTML = noCalendars(error);
    dlg.showModal();
    return;
  }
  const stored = await local.get(LAST_KEY);
  const last = cals.some((c) => calKey(c) === stored) ? stored : calKey(cals.find((c) => c.primary) || cals[0]);
  dlg.innerHTML = form(startFor(day), last);
  const places = (await local.get('places:recent')) || [];
  field('ev-places').innerHTML = places.map((p) => `<option value="${esc(p.label)}"></option>`).join('');
  paintCal();
  paintAllDay();
  keepLength(false);
  if (error) showError(`<p>Only some calendars are listed: ${esc(reason(error))}.</p>`);
  dlg.showModal();
  field('ev-title').focus();
}

export function initEvents(S, { onChange: changed }) {
  settingsRef = S;
  onChange = changed;
  const dlg = $('#event-dialog');
  const add = $('#add-event');
  if (add) {
    add.innerHTML = `${icon('plus')}<span>Add event</span>`;
    add.addEventListener('click', () => openEventEditor());
  }
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ev]');
    if (!b) return;
    if (b.dataset.ev === 'cancel' && !busy) dlg.close();
    else if (b.dataset.ev === 'settings') {
      dlg.close();
      openSettings(settingsRef, 'accounts');
    }
  });
  dlg.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'ev-cal') paintCal();
    else if (id === 'ev-allday') {
      paintAllDay();
      keepLength(false);
    } else if (id === 'ev-start-date' || id === 'ev-start-time') keepLength(true);
    else if (id === 'ev-end-date' || id === 'ev-end-time') keepLength(false);
  });
  dlg.addEventListener('input', () => {
    if (!busy && !field('ev-error')?.hidden) showError('');
  });
  // Escape can't close the form mid-save either: the save would then act on whatever is open next.
  dlg.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dlg.addEventListener('submit', (e) => {
    e.preventDefault();
    save(dlg);
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'ev-notes') {
      e.preventDefault();
      save(dlg);
    }
  });
}
