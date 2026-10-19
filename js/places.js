// Address suggestions and a map preview for the search bar's Maps mode.
// Suggestions come from Photon (photon.komoot.io, OpenStreetMap data, no key) and are ranked
// by distance from your weather location. The preview is an embedded Google Map.
import { $, esc, local } from './util.js';
import { icon } from './icons.js';

const ZOOM_FOR = { house: 17, street: 16, locality: 15, district: 14, city: 12, county: 10, state: 7, country: 5 };
// Countries that write the house number before the street.
const NUMBER_FIRST = new Set(['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'ZA', 'IN', 'PH', 'SG', 'MY']);

let input;
let isActive;
let navigate;
let panel;
let items = [];
let active = -1;
let lastQuery = '';
let pending;
let timer;
let bias = null;
// Your own country is left out of suggestions; others are spelled out.
const homeCountry = (navigator.language.split('-')[1] || '').toUpperCase();
const results = new Map();

const gmapsSearch = (label) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`;
const gmapsDirections = (label) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(label)}`;

function describe(f) {
  const p = { ...(f.properties || {}) };
  // Photon sometimes puts the house number in `name` for address points.
  if (p.name && !p.housenumber && p.street && /^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/i.test(p.name.trim())) {
    p.housenumber = p.name.trim();
    delete p.name;
  }
  const cc = (p.countrycode || '').toUpperCase();
  const street = p.street ? (p.housenumber ? (NUMBER_FIRST.has(cc) ? `${p.housenumber} ${p.street}` : `${p.street} ${p.housenumber}`) : p.street) : '';
  const place = p.city || p.district || p.locality || p.county || '';
  const region = [p.state, p.postcode].filter(Boolean).join(' ');
  const country = cc && cc !== homeCountry ? p.country : '';
  const named = p.name && p.name !== street && p.name !== place;
  const title = named ? p.name : street || place || p.state || p.country || 'Unnamed place';
  const detail = [named ? street : '', title === place ? '' : place, region, country].filter(Boolean).join(', ');
  const [lon, lat] = f.geometry?.coordinates || [0, 0];
  return { title, detail, label: [title, detail].filter(Boolean).join(', '), lat, lon, zoom: ZOOM_FOR[p.type] ?? 15, cc };
}

// Kilometers between two points; good enough for ranking.
function distance(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371;
}

// The place the weather is for: a chosen city, or the last location Chrome reported.
async function loadBias() {
  if (bias) return bias;
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    const manual = settings?.location?.mode === 'manual' && settings.location.lat != null ? settings.location : null;
    const geo = manual || (await local.get('geo'));
    if (geo?.lat != null) bias = { lat: geo.lat, lon: geo.lon };
  } catch {}
  return bias;
}

// Your own country first, then nearest first.
function rank(list) {
  return list
    .map((it, i) => ({ it, i, home: homeCountry && it.cc === homeCountry ? 0 : 1, km: bias ? distance(bias, it) : 0 }))
    .sort((a, b) => a.home - b.home || a.km - b.km || a.i - b.i)
    .map((x) => x.it);
}

async function suggest(q) {
  if (results.has(q)) return results.get(q);
  await loadBias();
  pending?.abort();
  pending = new AbortController();
  const params = new URLSearchParams({ q, limit: '15', lang: 'en' });
  if (bias) {
    params.set('lat', bias.lat);
    params.set('lon', bias.lon);
    params.set('zoom', '10');
    params.set('location_bias_scale', '0.6');
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: pending.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const seen = new Set();
  const list = rank(((await res.json()).features || []).map(describe))
    .filter((it) => !seen.has(it.label) && seen.add(it.label))
    .slice(0, 6);
  results.set(q, list);
  return list;
}

// ---- Map -----------------------------------------------------------------------------

let mapTimer;
let mapSrc = '';

function embedUrl() {
  const item = items[active];
  const params = item
    ? { q: item.label, z: String(item.zoom), output: 'embed' }
    : bias
      ? { q: `${bias.lat},${bias.lon}`, z: '12', output: 'embed' }
      : null;
  return params ? `https://www.google.com/maps?${new URLSearchParams(params)}` : '';
}

// Arrow keys move quickly through suggestions; only reload the map once they settle.
function drawMap({ now = false } = {}) {
  clearTimeout(mapTimer);
  const apply = () => {
    const src = embedUrl();
    const frame = panel.querySelector('.pm-frame');
    if (!src || src === mapSrc) return;
    mapSrc = src;
    frame.src = src;
  };
  if (now) apply();
  else mapTimer = setTimeout(apply, 300);
}

// ---- Panel ---------------------------------------------------------------------------

function render(state) {
  const list = panel.querySelector('.places-list');
  if (state === 'error') list.innerHTML = '<li class="places-note">Address suggestions aren’t available right now. Press Enter to search Google Maps.</li>';
  else if (!items.length) list.innerHTML = `<li class="places-note">${state === 'loading' ? 'Looking up addresses…' : 'No matching addresses. Press Enter to search Google Maps.'}</li>`;
  else
    list.innerHTML = items
      .map(
        (it, i) => `<li id="place-${i}" role="option" class="place${i === active ? ' on' : ''}" aria-selected="${i === active}" data-place="${i}">
          ${icon('pin')}<span class="place-text"><span class="place-title">${esc(it.title)}</span>${it.detail ? `<span class="place-detail">${esc(it.detail)}</span>` : ''}</span>
        </li>`,
      )
      .join('');
  input.setAttribute('aria-activedescendant', active >= 0 ? `place-${active}` : '');
  const item = items[active];
  const actions = panel.querySelector('.pm-actions');
  actions.innerHTML = item
    ? `<a class="btn small primary" href="${esc(gmapsDirections(item.label))}">Directions</a><a class="btn small" href="${esc(gmapsSearch(item.label))}">${icon('external')}Open in Google Maps</a>`
    : '';
}

function highlight(i) {
  active = i;
  render();
  drawMap();
}

function open() {
  if (!panel.hidden) return;
  panel.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  drawMap({ now: true });
}

export function closePlaces() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

const queryText = () => input.value.replace(/^!m\s+/i, '').trim();

// Called on every input and engine change.
export function updatePlaces() {
  if (!panel) return;
  const q = queryText();
  if (!isActive() || q.length < 3) {
    closePlaces();
    return;
  }
  open();
  if (q === lastQuery) return;
  lastQuery = q;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!items.length) render('loading');
    try {
      const list = await suggest(q);
      if (q !== lastQuery) return;
      items = list;
      highlight(items.length ? 0 : -1);
    } catch (err) {
      if (err.name === 'AbortError') return;
      items = [];
      active = -1;
      render('error');
    }
  }, 220);
}

// Enter in Maps mode opens the highlighted address. Returns false when there's nothing to open.
export function openActivePlace(newTab) {
  if (panel?.hidden !== false || active < 0 || !items[active]) return false;
  navigate(gmapsSearch(items[active].label), newTab);
  return true;
}

export async function initPlaces(opts) {
  ({ input, isActive, navigate } = opts);
  panel = $('#places');
  panel.innerHTML = `
    <ul class="places-list" id="places-list" role="listbox" aria-label="Address suggestions"></ul>
    <div class="places-map">
      <iframe class="pm-frame" title="Map of the highlighted address" referrerpolicy="no-referrer-when-downgrade" loading="lazy"></iframe>
      <div class="pm-actions"></div>
    </div>
    <p class="places-credit">Address suggestions © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, via Photon</p>`;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'places-list');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('input', updatePlaces);
  input.addEventListener('focus', updatePlaces);
  input.addEventListener('keydown', (e) => {
    if (panel.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + items.length) % items.length);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePlaces();
    }
  });
  // Clicking or dragging inside the panel keeps the cursor in the search box.
  panel.addEventListener('mousedown', (e) => {
    if (!e.target.closest('a, button')) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && document.activeElement !== input) closePlaces();
  });
  panel.querySelector('.places-list').addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-place]');
    if (!li) return;
    e.preventDefault(); // keep focus in the search box
    highlight(Number(li.dataset.place));
  });
  panel.querySelector('.places-list').addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-place]')) openActivePlace(e.metaKey || e.ctrlKey);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#places, .search-box, #engines')) closePlaces();
  });
  loadBias();
}
