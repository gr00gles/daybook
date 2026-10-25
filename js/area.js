// Things happening near you: concerts, shows, festivals and games from Ticketmaster's
// Discovery API (free key from developer.ticketmaster.com), around the weather location.
// Without a key the card still offers web searches for brewery events, festivals and the
// weekend, which find the small local listings Ticketmaster doesn't carry.
import { $, esc, cached, hash, errorText, safeUrl, fmtTime } from './util.js';
import { locate } from './weather.js';
import { icon } from './icons.js';
import { setTicker } from './ticker.js';

const API = 'https://app.ticketmaster.com/discovery/v2/events.json';
const SHOWN = 5;

// Ticketmaster's segments. "Other" is Miscellaneous: fairs, festivals, family and community events.
export const AREA_KINDS = {
  music: { label: 'Concerts', segment: 'Music' },
  arts: { label: 'Theater and comedy', segment: 'Arts & Theatre' },
  other: { label: 'Festivals, fairs and family', segment: 'Miscellaneous' },
  sports: { label: 'Sports', segment: 'Sports' },
  film: { label: 'Film', segment: 'Film' },
};

const SEARCHES = [
  ['Brewery events', 'brewery events near'],
  ['Festivals', 'festivals near'],
  ['This weekend', 'things to do this weekend near'],
];

class KeyRejected extends Error {}

const kindOf = (segment) => Object.keys(AREA_KINDS).find((k) => AREA_KINDS[k].segment === segment) || 'other';

// The widest small picture, so the card doesn't download posters.
function thumb(images = []) {
  const wide = images.filter((i) => i.url && (i.ratio === '16_9' || i.ratio === '3_2') && i.width >= 200);
  wide.sort((a, b) => a.width - b.width);
  return wide[0]?.url || images[0]?.url || '';
}

function simplify(e) {
  const venue = e._embedded?.venues?.[0];
  const start = e.dates?.start || {};
  const segment = e.classifications?.[0]?.segment?.name;
  const genre = e.classifications?.[0]?.genre?.name;
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    date: start.localDate, // YYYY-MM-DD at the venue
    time: start.timeTBA || start.noSpecificTime ? '' : start.localTime || '',
    at: start.dateTime ? Date.parse(start.dateTime) : null,
    venue: venue?.name || '',
    city: venue?.city?.name || '',
    kind: kindOf(segment),
    genre: genre && genre !== 'Undefined' && genre !== 'Miscellaneous' ? genre : '',
    image: thumb(e.images),
    cancelled: e.dates?.status?.code === 'cancelled',
  };
}

async function fetchEvents(key, loc, area, units) {
  const now = new Date();
  const until = new Date(now.getTime() + area.days * 86400e3);
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
  const q = new URLSearchParams({
    apikey: key,
    latlong: `${loc.lat},${loc.lon}`,
    radius: String(area.radius),
    unit: units === 'C' ? 'km' : 'miles',
    startDateTime: iso(now),
    endDateTime: iso(until),
    sort: 'date,asc',
    size: '100',
  });
  const res = await fetch(`${API}?${q}`);
  if (res.status === 401) throw new KeyRejected('Ticketmaster didn’t accept the key');
  if (res.status === 429) throw new Error('Ticketmaster says too many requests; trying again later');
  if (!res.ok) throw new Error(`Ticketmaster returned ${res.status}`);
  const r = await res.json();
  return (r._embedded?.events || []).map(simplify);
}

// Ticketmaster lists parking passes and add-ons as events, and every date of a run separately.
// Keep the first date of each and count the rest.
function tidy(events, kinds) {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const byName = new Map();
  for (const e of events) {
    if (!e.date || e.date < today || e.cancelled) continue;
    if (!kinds.includes(e.kind)) continue;
    if (/\b(parking|add-?on|upgrade|vip package|hospitality)\b/i.test(e.name)) continue;
    const k = e.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seen = byName.get(k);
    if (seen) seen.more += seen.date === e.date ? 0 : 1;
    else byName.set(k, { ...e, more: 0 });
  }
  return [...byName.values()];
}

function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date().setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return day.toLocaleDateString(undefined, diff < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(e, h24) {
  if (!e.time) return '';
  if (e.at) return fmtTime(e.at, h24);
  const [h, m] = e.time.split(':').map(Number);
  return fmtTime(new Date(2000, 0, 1, h, m).getTime(), h24);
}

function item(e, h24) {
  const where = [e.venue, e.city].filter(Boolean).join(', ');
  const meta = [timeLabel(e, h24), where].filter(Boolean).join(' · ');
  const tag = e.genre || AREA_KINDS[e.kind].label.split(/,| and /)[0];
  return `<li><a class="ae" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">
    ${e.image ? `<img class="ae-img" src="${esc(safeUrl(e.image))}" alt="" loading="lazy">` : `<span class="ae-img none">${icon('pin')}</span>`}
    <span class="ae-text">
      <span class="ae-name">${esc(e.name)}</span>
      <span class="ae-meta">${esc(meta)}</span>
      <span class="ae-tags"><span class="ae-tag k-${e.kind}">${esc(tag)}</span>${e.more ? `<span class="ae-more">+${e.more} more date${e.more === 1 ? '' : 's'}</span>` : ''}</span>
    </span>
  </a></li>`;
}

function list(events, h24, all) {
  const shown = all ? events : events.slice(0, SHOWN);
  let html = '';
  let day = '';
  for (const e of shown) {
    if (e.date !== day) {
      if (day) html += '</ol>';
      day = e.date;
      html += `<p class="ae-day">${esc(dayLabel(day))}</p><ol class="ae-list">`;
    }
    html += item(e, h24);
  }
  if (day) html += '</ol>';
  if (events.length > SHOWN)
    html += `<button class="linklike ae-toggle" type="button" data-area="toggle">${all ? 'Show fewer' : `Show all ${events.length}`}</button>`;
  return html;
}

function searches(place) {
  const near = place && place !== 'Your location' ? place : 'me';
  return `<div class="ae-search">${SEARCHES.map(
    ([label, q]) => `<a class="chip" href="https://www.google.com/search?${new URLSearchParams({ q: `${q} ${near}` })}" target="_blank" rel="noopener">${icon('search')}${esc(label)}</a>`,
  ).join('')}</div>`;
}

let state = { events: [], all: false, h24: false };
let rejected = '';

function paintList() {
  const box = $('#area-list');
  if (box) box.innerHTML = list(state.events, state.h24, state.all);
}

function render(S, loc, data, meta, sig) {
  const body = $('#area-body');
  if (meta.error instanceof KeyRejected) rejected = sig;
  else if (meta.fresh) rejected = '';
  $('#area-updated').textContent = meta.error && data ? "couldn't refresh" : '';
  if (rejected === sig) {
    body.innerHTML = `<div class="notice warn"><p>${esc(meta.error.message)}. Check it in Settings.</p><button class="btn small" type="button" data-open-settings="area">Open Settings</button></div>${searches(loc.name)}`;
    return;
  }
  if (!data) {
    body.innerHTML = `<p class="notice warn">Events aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p>${searches(loc.name)}`;
    return;
  }
  state = { ...state, events: tidy(data, S.area.kinds), h24: S.clock24 };
  setTicker(
    'area',
    state.events.map((e) => ({ tag: dayLabel(e.date), title: e.name, meta: [timeLabel(e, S.clock24), e.venue].filter(Boolean).join(' · '), href: e.url, newTab: true })),
  );
  const km = S.units === 'C';
  body.innerHTML = `${state.events.length ? '<div id="area-list"></div>' : `<p class="quiet">Nothing listed within ${S.area.radius} ${km ? 'km' : 'miles'} in the next ${S.area.days} days.</p>`}${searches(loc.name)}`;
  paintList();
}

export function refreshArea(S, force = false) {
  const body = $('#area-body');
  const key = (S.area.key || '').trim();
  (async () => {
    let loc;
    try {
      loc = await locate(S);
    } catch {
      $('#area-place').textContent = '';
      body.innerHTML = `<div class="notice setup"><p>Events near you need a location. Pick your city and they show up here.</p><button class="btn small primary" type="button" data-open-settings="location">Choose a city</button></div>`;
      return;
    }
    $('#area-place').textContent = loc.name && loc.name !== 'Your location' ? `near ${loc.name}` : '';
    if (!key) {
      $('#area-updated').textContent = '';
      body.innerHTML = `<p class="ae-key">A free Ticketmaster key lists concerts, shows and games nearby. <button class="linklike" type="button" data-open-settings="area">Add a key</button></p>${searches(loc.name)}`;
      return;
    }
    const lat = (+loc.lat).toFixed(2);
    const lon = (+loc.lon).toFixed(2);
    const sig = hash([key, lat, lon, S.area.radius, S.area.days, S.units]);
    await cached({
      key: 'area',
      sig,
      maxAge: 3 * 3600e3,
      force,
      fetch: () => fetchEvents(key, { lat, lon }, S.area, S.units),
      render: (data, meta) => render(S, loc, data, meta, sig),
    });
  })();
}

export function initArea() {
  $('#area-body').addEventListener('click', (e) => {
    if (!e.target.closest('[data-area="toggle"]')) return;
    state.all = !state.all;
    paintList();
  });
}
