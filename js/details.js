// An event's details: clicking anywhere on an event opens them in a window over the page, with
// the time, place, video call, notes and guests, and an Edit button on calendars you can change.
// The notes and guests are loaded when it opens, since the calendar lists leave them out.
import { $, esc, colorVar, fmtTime, safeUrl, errorText, startOfDay, addDays } from './util.js';
import { shownEvent, eventHref, tripLine } from './calendar.js';
import { gapi } from './gauth.js';
import { graph } from './msauth.js';
import { msClientId } from './settings.js';
import { openEventEditor, deleteEvent } from './events.js';
import { icon } from './icons.js';

let settingsRef;
let current = null; // { event, more: Promise }

const gmaps = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const directions = (q) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;

const LONG = { weekday: 'long', month: 'long', day: 'numeric' };
const SHORT = { weekday: 'short', month: 'short', day: 'numeric' };

function whenText(e) {
  const h24 = settingsRef.clock24;
  const year = (t) => (new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {});
  if (e.allDay) {
    const last = addDays(e.end, -1);
    if (startOfDay(last) <= startOfDay(e.start)) return `${new Date(e.start).toLocaleDateString(undefined, { ...LONG, ...year(e.start) })} · All day`;
    return `${new Date(e.start).toLocaleDateString(undefined, { ...SHORT, ...year(e.start) })} – ${new Date(last).toLocaleDateString(undefined, { ...SHORT, ...year(last) })} · All day`;
  }
  if (startOfDay(e.start) === startOfDay(e.end - 1))
    return `${new Date(e.start).toLocaleDateString(undefined, { ...LONG, ...year(e.start) })} · ${fmtTime(e.start, h24)} – ${fmtTime(e.end, h24)}`;
  const at = (t) => `${new Date(t).toLocaleDateString(undefined, { ...SHORT, ...year(t) })}, ${fmtTime(t, h24)}`;
  return `${at(e.start)} – ${at(e.end)}`;
}

function lengthText(e) {
  if (e.allDay) return '';
  const m = Math.round((e.end - e.start) / 60e3);
  if (m <= 0 || m >= 24 * 60) return '';
  const h = Math.floor(m / 60);
  return h ? `${h} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

// Calendar notes are often HTML (Outlook always, Google sometimes). Shown and edited as text.
const looksLikeHtml = (s) => /<\/?[a-z][\s\S]*?>/i.test(s);
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, head, title').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((n) => n.append('\n'));
  // Links whose text isn't the address keep the address, so it stays clickable.
  doc.querySelectorAll('a[href^="http"]').forEach((a) => {
    if (!a.textContent.includes(a.getAttribute('href'))) a.append(` (${a.getAttribute('href')})`);
  });
  return (doc.body?.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
function linkify(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += esc(text.slice(last, m.index));
    out += `<a href="${esc(safeUrl(m[0]))}" target="_blank" rel="noopener">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const RESPONSE = { accepted: 'Going', tentativelyAccepted: 'Maybe', tentative: 'Maybe', declined: 'Not going', needsAction: 'Hasn’t answered', notResponded: 'Hasn’t answered', none: '' };

// What the details view loads: the full notes (raw, and as text), the full place and the guests.
async function loadMore(e) {
  const id = e.apiId || e.id;
  if (e.src === 'google') {
    const q = new URLSearchParams({
      maxAttendees: '60',
      fields: 'description,location,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,resource)',
    });
    const r = await gapi(`/calendar/v3/calendars/${encodeURIComponent(e.calId)}/events/${encodeURIComponent(id)}?${q}`);
    const raw = r.description || '';
    return {
      raw,
      type: 'text',
      notes: looksLikeHtml(raw) ? htmlToText(raw) : raw,
      location: r.location || '',
      organizer: r.organizer?.self ? 'You' : r.organizer?.displayName || r.organizer?.email || '',
      guests: (r.attendees || []).filter((a) => !a.resource).map((a) => ({ name: a.self ? 'You' : a.displayName || a.email, status: RESPONSE[a.responseStatus] ?? '', organizer: a.organizer })),
    };
  }
  if (e.src === 'outlook') {
    const r = await graph(msClientId(settingsRef), `/me/events/${encodeURIComponent(id)}?$select=body,location,organizer,attendees,isOrganizer`);
    const raw = r.body?.content || '';
    const type = r.body?.contentType === 'html' ? 'html' : 'text';
    return {
      raw,
      type,
      notes: type === 'html' ? htmlToText(raw) : raw.trim(),
      location: r.location?.displayName || '',
      organizer: r.isOrganizer ? 'You' : r.organizer?.emailAddress?.name || r.organizer?.emailAddress?.address || '',
      guests: (r.attendees || []).filter((a) => a.type !== 'resource').map((a) => ({ name: a.emailAddress?.name || a.emailAddress?.address || '', status: RESPONSE[a.status?.response] ?? '' })),
    };
  }
  return null;
}

function moreHtml(e, more) {
  const parts = [];
  if (more.organizer && more.guests.length) parts.push(`<p class="evd-row">${icon('person')}<span>Organized by ${esc(more.organizer)}</span></p>`);
  if (more.guests.length) {
    const shown = more.guests.slice(0, 12);
    parts.push(`<div class="evd-guests"><h3 class="eyebrow">${more.guests.length} guest${more.guests.length === 1 ? '' : 's'}</h3><ul>${shown
      .map((g) => `<li><span class="evd-guest">${esc(g.name)}</span>${g.status ? `<span class="evd-rsvp">${esc(g.status)}</span>` : ''}</li>`)
      .join('')}${more.guests.length > shown.length ? `<li class="evd-rsvp">and ${more.guests.length - shown.length} more</li>` : ''}</ul></div>`);
  }
  const notes = more.notes ?? e.notes ?? '';
  if (notes) parts.push(`<div class="evd-notes"><h3 class="eyebrow">Notes</h3><p>${linkify(notes.length > 6000 ? `${notes.slice(0, 6000)}…` : notes)}</p></div>`);
  return parts.join('');
}

function view(e) {
  const now = Date.now();
  const state = e.end <= now ? 'past' : e.start <= now ? 'current' : '';
  const place = e.location && !/^https?:/.test(e.location) ? e.location : '';
  const len = lengthText(e);
  const canEdit = Boolean(e.editable && (e.src === 'google' || e.src === 'outlook'));
  const game = String(e.id).startsWith('game:'); // a followed team's game (teams.js)
  const where = e.src === 'outlook' ? 'Outlook' : e.src === 'google' ? 'Google Calendar' : game ? 'ESPN' : '';
  const readOnly = game ? 'Games come from ESPN, so they can only be read here.' : !e.src ? 'Added by iCal link, so it can only be read here.' : !canEdit ? 'You can’t change this one here: it’s someone else’s invitation or on a calendar you can only read.' : '';
  return `<article class="evd" style="--c: ${colorVar(e.color)}">
    <header class="ev-form-head evd-head">
      <span class="evd-swatch" aria-hidden="true"></span>
      <h2 id="ev-h">${esc(e.title)}</h2>
      <button class="icon-btn" type="button" data-evd="close" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="evd-body">
      <p class="evd-row evd-when">${icon('clock')}<span>${esc(whenText(e))}${len ? `<span class="evd-len"> · ${esc(len)}</span>` : ''}${state === 'current' && !e.allDay ? ' <span class="pill now-pill">Now</span>' : ''}${e.recurring ? '<span class="evd-len"> · Repeats</span>' : ''}</span></p>
      <p class="evd-row"><span class="cal-dot" style="--c: ${colorVar(e.color)}"></span><span>${esc(e.calName || 'Calendar')}</span></p>
      ${place
        ? `<div class="evd-row evd-place">${icon('pin')}<span><span class="evd-where" id="evd-where">${esc(place)}</span>
            <span class="evd-links"><a href="${esc(gmaps(place))}" target="_blank" rel="noopener">Map</a><a href="${esc(directions(place))}" target="_blank" rel="noopener">Directions</a></span>
            ${tripLine(e, state, settingsRef.clock24)}</span></div>`
        : ''}
      ${e.join ? `<p class="evd-row">${icon('video')}<a class="join" href="${esc(safeUrl(e.join))}" target="_blank" rel="noopener">Join video call</a></p>` : ''}
      <div class="evd-more" id="evd-more">${e.src === 'google' || e.src === 'outlook' ? '<p class="quiet">Loading notes and guests…</p>' : moreHtml(e, { guests: [], notes: e.notes || '' })}</div>
      ${readOnly ? `<p class="hint evd-ro">${esc(readOnly)}</p>` : ''}
    </div>
    <footer class="ev-form-foot evd-foot">
      ${e.link || e.src === 'google' ? `<a class="btn" href="${esc(eventHref(e))}" target="_blank" rel="noopener">${icon('external')}Open in ${where || 'calendar'}</a>` : ''}
      ${canEdit ? `<button class="btn danger evd-delete" type="button" data-evd="delete">${icon('trash')}Delete</button>` : ''}
      ${canEdit ? `<button class="btn primary" type="button" data-evd="edit">Edit</button>` : ''}
    </footer>
    <div class="evd-confirm" id="evd-confirm" role="alertdialog" aria-labelledby="evd-confirm-q" hidden>
      <p id="evd-confirm-q"><strong>Delete ${e.recurring ? 'this one event' : 'this event'}?</strong> <span id="evd-confirm-why">${e.recurring ? 'The rest of the series stays.' : ''}</span></p>
      <p class="ev-error" id="evd-error" role="alert" hidden></p>
      <div class="evd-confirm-btns">
        <button class="btn" type="button" data-evd="keep">Cancel</button>
        <button class="btn danger-fill" type="button" data-evd="confirm-delete">Delete</button>
      </div>
    </div>
  </article>`;
}

export function openEventDetails(e) {
  const dlg = $('#event-dialog');
  if (!dlg || !e) return;
  if (dlg.open && !current) return; // the add-event form is open
  current = { event: e, more: loadMore(e).catch((err) => ({ error: err })) };
  const mine = current;
  dlg.innerHTML = view(e);
  if (!dlg.open) dlg.showModal();
  (dlg.querySelector('[data-evd="edit"]') || dlg.querySelector('[data-evd="close"]')).focus({ focusVisible: false });
  mine.more.then((more) => {
    if (current !== mine || !dlg.open) return;
    const box = $('#evd-more');
    if (!box || !more) return;
    if (more.error) {
      box.innerHTML = `${e.notes ? moreHtml(e, { guests: [], notes: e.notes }) : ''}<p class="quiet">Couldn’t load the notes and guests: ${esc(errorText(more.error))}.</p>`;
      return;
    }
    box.innerHTML = moreHtml(e, more);
    // The calendar list cuts long places short; this is the whole of it.
    const where = $('#evd-where');
    if (where && more.location) where.textContent = more.location;
  });
}

export function initDetails(S) {
  settingsRef = S;
  const dlg = $('#event-dialog');
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-event]');
    if (!b || ev.target.closest('a.join')) return;
    ev.preventDefault();
    openEventDetails(shownEvent(b.dataset.event));
  });
  dlg.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-evd]');
    if (!b) {
      // A click on the dimmed page around it closes it.
      if (ev.target === dlg && current) dlg.close();
      return;
    }
    if (b.dataset.evd === 'close') dlg.close();
    else if (b.dataset.evd === 'delete' && current) {
      const box = $('#evd-confirm');
      box.hidden = false;
      $('.evd-foot').hidden = true;
      // Guests hear about it from the calendar; say so before it happens.
      const more = await current.more;
      const guests = (more?.guests || []).filter((g) => g.name !== 'You').length;
      const why = $('#evd-confirm-why');
      if (guests && why && !why.dataset.guests) {
        why.dataset.guests = '1';
        why.textContent += ` ${guests === 1 ? 'Your guest' : `All ${guests} guests`} will see it taken off their calendar${guests === 1 ? '' : 's'}.`;
      }
      dlg.querySelector('[data-evd="confirm-delete"]')?.focus();
    } else if (b.dataset.evd === 'keep') {
      $('#evd-confirm').hidden = true;
      $('.evd-foot').hidden = false;
    } else if (b.dataset.evd === 'confirm-delete' && current) {
      const { event, more } = current;
      b.disabled = true;
      b.textContent = 'Deleting…';
      const loaded = await more;
      try {
        await deleteEvent(event, loaded && !loaded.error ? loaded : null);
        dlg.close();
      } catch (err) {
        const box = $('#evd-error');
        box.textContent = err.code === 'needs-google' || err.code === 'needs-connect' ? `${errorText(err)}. Reconnect in Settings → Accounts, then try again.` : `Couldn’t delete it: ${errorText(err).replace(/[.\s]+$/, '')}.`;
        box.hidden = false;
        b.disabled = false;
        b.textContent = 'Delete';
      }
    } else if (b.dataset.evd === 'edit' && current) {
      const { event, more } = current;
      b.disabled = true;
      b.textContent = 'Loading…';
      const loaded = await more;
      current = null;
      openEventEditor({ event, more: loaded && !loaded.error ? loaded : null });
    }
  });
  dlg.addEventListener('close', () => {
    current = null;
  });
}
