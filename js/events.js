// Adding or changing an event: a small form for the title, time, place and which calendar it
// goes on. Google calendars get it through the Calendar API and Outlook through Microsoft Graph;
// the first time, each asks for permission to add events. Undo deletes it again, or puts the
// changes back.
import { $, esc, local, colorVar, showToast, errorText, startOfDay, addDays } from './util.js';
import { writableCalendars, calendarsChanged, addPendingEvent, removePendingEvent, forgetEvent, unforgetEvent, editPendingEvent } from './calendar.js';
import { calendarWrite } from './gauth.js';
import { graph, graphWrite } from './msauth.js';
import { msClientId } from './settings.js';
import { openSettings } from './sheet.js';
import { icon } from './icons.js';
import { attachAddressSuggest } from './address.js';

const LAST_KEY = 'event:lastCal';
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let settingsRef;
let onChange = () => {};
let cals = [];
let busy = false;
// While changing an event: { event, more, cal }, where more holds what its details view loaded.
let editing = null;

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

// v: the values to start from (title, start, end, allDay, location, notes); for all-day events
// end is the morning after the last day, as calendars keep it.
function form(v, last) {
  const { start, end } = v;
  const lastDay = v.allDay ? addDays(end, -1) : end;
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
  const notesLocked = editing && editing.more?.notes == null;
  return `<form class="ev-form${editing ? ' editing' : ''}" id="ev-form" novalidate>
    <header class="ev-form-head">
      <h2 id="ev-h">${editing ? 'Edit event' : 'New event'}</h2>
      <button class="icon-btn" type="button" data-ev="cancel" aria-label="Close">${icon('close')}</button>
    </header>
    <label class="field"><span>Title</span><input id="ev-title" type="text" maxlength="300" placeholder="Add a title" autocomplete="off" value="${esc(v.title || '')}"></label>
    <label class="field"><span>Calendar</span>
      <span class="ev-cal"><span class="cal-dot" id="ev-cal-dot"></span><select id="ev-cal"${editing ? ' disabled' : ''}>${options}</select></span>
    </label>
    ${editing?.event.recurring ? '<p class="hint ev-hint">This is one of a series. Changes here apply to this one only.</p>' : ''}
    <label class="check"><input type="checkbox" id="ev-allday"${v.allDay ? ' checked' : ''}><span>All day</span></label>
    <div class="ev-when">
      <label class="field"><span>Starts</span><input id="ev-start-date" type="date" value="${ymd(start)}" required></label>
      <label class="field ev-clock"><span>Start time</span><input id="ev-start-time" type="time" step="300" value="${v.allDay ? '09:00' : hm(start)}"></label>
      <label class="field"><span>Ends</span><input id="ev-end-date" type="date" value="${ymd(lastDay)}" required></label>
      <label class="field ev-clock"><span>End time</span><input id="ev-end-time" type="time" step="300" value="${v.allDay ? '10:00' : hm(end)}"></label>
    </div>
    <div class="field ev-place"><label for="ev-location">Location</label><input id="ev-location" type="text" maxlength="300" placeholder="Address or place (optional)" autocomplete="off" value="${esc(v.location || '')}"></div>
    <label class="check" id="ev-meet-row"><input type="checkbox" id="ev-meet"><span>Add a Google Meet video call</span></label>
    <label class="field"><span>Notes</span><textarea id="ev-notes" rows="3" maxlength="4000" placeholder="${notesLocked ? 'The notes couldn’t be loaded, so they stay as they are' : 'Optional'}"${notesLocked ? ' disabled' : ''}>${esc(editing?.more?.notes || '')}</textarea></label>
    <div class="ev-error" id="ev-error" role="alert" hidden></div>
    <footer class="ev-form-foot">
      <button class="btn" type="button" data-ev="cancel">Cancel</button>
      <button class="btn primary" type="submit" id="ev-save">${editing ? 'Save changes' : 'Add event'}</button>
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
  field('ev-meet-row').hidden = c?.kind !== 'google' || Boolean(editing);
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

// Google's start and end for an event; `end` is the morning after the last day when all day.
// The other kind of time is cleared, for when a change turns one into the other.
const googleWhen = (allDay, start, end) => ({
  start: allDay ? { date: ymd(start), dateTime: null, timeZone: null } : { dateTime: rfc3339(start), timeZone: ZONE, date: null },
  end: allDay ? { date: ymd(end), dateTime: null, timeZone: null } : { dateTime: rfc3339(end), timeZone: ZONE, date: null },
});

// The moment an event in the form ends: all-day events end the morning after their last day.
const endOf = (d) => (d.allDay ? addDays(at(d.endDate), 1) : d.end);

async function addGoogle(cal, d) {
  const { start, end } = googleWhen(d.allDay, d.start, endOf(d));
  const body = {
    summary: d.title,
    location: d.location || undefined,
    description: d.notes || undefined,
    start: d.allDay ? { date: start.date } : { dateTime: start.dateTime, timeZone: ZONE },
    end: d.allDay ? { date: end.date } : { dateTime: end.dateTime, timeZone: ZONE },
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

// Outlook's start and end. Timed events go in as UTC, which can't be misread; all-day events
// need midnight in your own time zone so they cover the right days.
async function outlookWhen(clientId, allDay, start, end) {
  const zone = allDay ? await outlookZone(clientId, [start, end]) : 'UTC';
  const when = (t) => (allDay ? { dateTime: `${ymd(t)}T00:00:00`, timeZone: zone } : { dateTime: new Date(t).toISOString().slice(0, 19), timeZone: 'UTC' });
  return { isAllDay: allDay, start: when(start), end: when(end) };
}

async function addOutlook(d) {
  const clientId = msClientId(settingsRef);
  const body = {
    subject: d.title,
    ...(await outlookWhen(clientId, d.allDay, d.start, endOf(d))),
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

// An event's values, in the shape the calendars take and give back.
const valuesOf = (e, more) => ({
  title: e.title,
  allDay: e.allDay,
  start: e.start,
  end: e.end,
  location: more?.location ?? e.location ?? '',
});

// Sends a change to one event: `to` and `from` are values as valuesOf gives them, and only the
// parts that differ go out. Notes go as they are given (raw, with their kind for Outlook).
async function patchEvent(ev, to, from, notes) {
  const id = ev.apiId || ev.id;
  const when = to.allDay !== from.allDay || to.start !== from.start || to.end !== from.end;
  if (ev.src === 'google') {
    const body = {};
    if (to.title !== from.title) body.summary = to.title;
    if (to.location !== from.location) body.location = to.location;
    if (notes) body.description = notes.content;
    if (when) Object.assign(body, googleWhen(to.allDay, to.start, to.end));
    return calendarWrite(`/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  }
  const clientId = msClientId(settingsRef);
  const body = {};
  if (to.title !== from.title) body.subject = to.title;
  if (to.location !== from.location) body.location = { displayName: to.location };
  if (notes) body.body = { contentType: notes.type || 'text', content: notes.content };
  if (when) Object.assign(body, await outlookWhen(clientId, to.allDay, to.start, to.end));
  return graphWrite(clientId, `/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body, need: 'Calendars.ReadWrite' });
}

function saveFailed(dlg, err, what) {
  if (err.code === 'needs-admin')
    showError(`<p>Your organization needs to approve Daybook changing events on your calendar.</p><p><a href="${esc(err.adminUrl)}" target="_blank" rel="noopener">Approval link to send to your IT team</a></p>`);
  else if (err.code === 'needs-google' || err.code === 'needs-connect')
    showError(`<p>${esc(reason(err))}. Reconnect in Settings → Accounts, then try again.</p>`);
  else if (err.status === 403 && editing)
    showError(`<p>This calendar didn’t allow the change: ${esc(reason(err))}. Only the person who sent an invitation can change it.</p>`);
  else showError(`<p>Couldn’t ${what}: ${esc(reason(err))}.</p>`);
  // Closed meanwhile (Chrome lets Escape through in the end): say so where it can be seen.
  if (!dlg.open) showToast(`The event wasn’t ${what === 'add the event' ? 'added' : 'changed'}: ${reason(err)}.`);
}

async function saveEdit(dlg) {
  const { event: ev, more, cal } = editing;
  const d = read();
  const why = problem(d, cal);
  if (why) {
    showError(`<p>${esc(why)}</p>`);
    if (!d.title) field('ev-title').focus();
    return;
  }
  const from = valuesOf(ev, more);
  const to = { title: d.title, allDay: d.allDay, start: d.start, end: endOf(d), location: d.location };
  // Notes only go out when they were loaded and then changed, so formatting nobody touched stays.
  const notesChanged = more?.notes != null && d.notes !== more.notes.trim();
  const same = to.title === from.title && to.allDay === from.allDay && to.start === from.start && to.end === from.end && to.location === from.location;
  if (same && !notesChanged) {
    dlg.close();
    return;
  }
  busy = true;
  const btn = field('ev-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  showError('');
  try {
    await patchEvent(ev, to, from, notesChanged ? { content: d.notes, type: 'text' } : null);
    dlg.close();
    const show = (v) => {
      editPendingEvent(ev.id, { title: v.title, allDay: v.allDay, start: v.start, end: v.end, location: v.location });
      calendarsChanged();
      onChange();
    };
    show(to);
    showToast(`Changed in ${cal.kind === 'outlook' ? 'Outlook' : cal.name}`, async () => {
      try {
        await patchEvent(ev, from, to, notesChanged ? { content: more.raw, type: more.type } : null);
        show(from);
        showToast('Change undone');
      } catch (err) {
        showToast(`Couldn’t undo it: ${reason(err)}.`);
      }
    });
  } catch (err) {
    saveFailed(dlg, err, 'save the changes');
  } finally {
    busy = false;
    if (dlg.open) {
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  }
}

async function save(dlg) {
  if (busy) return;
  if (editing) return saveEdit(dlg);
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
    if (cal.shown)
      addPendingEvent({
        id: `new:${made.id}`, apiId: made.id, title: d.title, start: d.start, end, allDay: d.allDay, location: d.location, join: made.join, link: made.link,
        color: cal.color, calName: cal.name, src: cal.kind, calId: cal.id, editable: true, notes: d.notes,
      });
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
    saveFailed(dlg, err, 'add the event');
  } finally {
    busy = false;
    if (dlg.open) {
      btn.disabled = false;
      btn.textContent = 'Add event';
    }
  }
}

// Deletes an event (just this one of a series), from its details view; `more` is what that
// loaded. Google keeps deleted events, so Undo brings the same one back. Outlook doesn't, so
// Undo adds a copy (title, time, place, notes), and only when nobody else was invited, since
// a copy wouldn't be on their calendars. Throws when the calendar refuses.
export async function deleteEvent(ev, more) {
  if (busy) return;
  busy = true;
  const id = ev.apiId || ev.id;
  const cal = ev.src === 'outlook' ? 'Outlook' : ev.calName;
  try {
    if (ev.src === 'google') {
      const path = `/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(id)}`;
      try {
        await calendarWrite(path, { method: 'DELETE' });
      } catch (err) {
        // 410: it was already deleted somewhere else.
        if (err.status !== 410) throw err;
      }
    } else {
      await graphWrite(msClientId(settingsRef), `/me/events/${encodeURIComponent(id)}`, { method: 'DELETE', need: 'Calendars.ReadWrite' });
    }
  } finally {
    busy = false;
  }
  const hide = () => {
    removePendingEvent(ev.id);
    forgetEvent(ev.id);
    calendarsChanged();
    onChange();
  };
  hide();
  const others = (more?.guests || []).filter((g) => g.name !== 'You').length;
  let undo = null;
  if (ev.src === 'google')
    undo = async () => {
      await calendarWrite(`/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'confirmed' } });
      unforgetEvent(ev.id);
    };
  else if (!others)
    undo = async () => {
      const clientId = msClientId(settingsRef);
      const body = {
        subject: ev.title,
        ...(await outlookWhen(clientId, ev.allDay, ev.start, ev.end)),
        location: (more?.location ?? ev.location) ? { displayName: more?.location ?? ev.location } : undefined,
        body: more?.raw ? { contentType: more.type || 'text', content: more.raw } : undefined,
      };
      const made = await graphWrite(clientId, '/me/events', { body, need: 'Calendars.ReadWrite' });
      const { color, calName, src, editable } = ev;
      addPendingEvent({ id: `new:${made.id}`, apiId: made.id, title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, location: body.location?.displayName || '', link: made.webLink, join: '', color, calName, src, editable });
    };
  showToast(
    `Deleted from ${cal}`,
    undo &&
      (async () => {
        try {
          await undo();
          calendarsChanged();
          onChange();
          showToast('Event restored');
        } catch (err) {
          showToast(`Couldn’t restore it: ${reason(err)}.`);
        }
      }),
  );
}

// Opens the form. `day` (a local midnight) prefills the date, e.g. from the month calendar.
// With `event`, it changes that event instead, from its details view (`more` is what that loaded).
export async function openEventEditor({ day, event, more } = {}) {
  const dlg = $('#event-dialog');
  // While a save is waiting (on a permission window, say), the form stays as it is.
  if (!dlg || busy) return;
  if (event) {
    editing = { event, more, cal: { kind: event.src, id: event.calId || 'outlook', name: event.calName, color: event.color, shown: true } };
    cals = [editing.cal];
    dlg.innerHTML = form({ ...valuesOf(event, more) }, calKey(editing.cal));
    wireForm();
    if (!dlg.open) dlg.showModal();
    field('ev-title').focus();
    return;
  }
  if (dlg.open) return;
  editing = null;
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
  const start = startFor(day);
  dlg.innerHTML = form({ start, end: start + 3600e3, allDay: false }, last);
  wireForm();
  if (error) showError(`<p>Only some calendars are listed: ${esc(reason(error))}.</p>`);
  dlg.showModal();
  field('ev-title').focus();
}

function wireForm() {
  attachAddressSuggest(field('ev-location'));
  paintCal();
  paintAllDay();
  keepLength(false);
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
