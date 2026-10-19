// Address suggestions and a map preview for the search bar's Maps mode.
// Suggestions come from Photon (photon.komoot.io, OpenStreetMap data, no key), ranked by
// distance from your weather location. The map is drawn from CARTO's OpenStreetMap tiles.
import { $, esc, local } from './util.js';
import { icon } from './icons.js';

const TILE = 256;
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
const view = { lat: 0, lon: 0, z: 12 };

const gmapsSearch = (label) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`;
const gmapsDirections = (label) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(label)}`;

function describe(f) {
  const p = f.properties || {};
  const cc = (p.countrycode || '').toUpperCase();
  const street = p.street ? (p.housenumber ? (NUMBER_FIRST.has(cc) ? `${p.housenumber} ${p.street}` : `${p.street} ${p.housenumber}`) : p.street) : '';
  const place = p.city || p.district || p.locality || p.county || '';
  const region = [p.state, p.postcode].filter(Boolean).join(' ');
  const country = cc && cc !== homeCountry ? p.country : '';
  const named = p.name && p.name !== street && p.name !== place;
  const title = named ? p.name : street || place || p.state || p.country || 'Unnamed place';
  const detail = [named ? street : '', title === place ? '' : place, region, country].filter(Boolean).join(', ');
  const [lon, lat] = f.geometry?.coordinates || [0, 0];
  return { title, detail, label: [title, detail].filter(Boolean).join(', '), lat, lon, zoom: ZOOM_FOR[p.type] ?? 15 };
}

async function suggest(q) {
  if (results.has(q)) return results.get(q);
  pending?.abort();
  pending = new AbortController();
  const params = new URLSearchParams({ q, limit: '6', lang: 'en' });
  if (bias) {
    params.set('lat', bias.lat);
    params.set('lon', bias.lon);
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: pending.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = ((await res.json()).features || []).map(describe);
  results.set(q, list);
  return list;
}

// ---- Map -----------------------------------------------------------------------------

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

const project = (lat, lon, z) => {
  const n = 2 ** z;
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n * TILE, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE };
};

const unproject = (x, y, z) => {
  const n = 2 ** z * TILE;
  return { lon: (x / n) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI };
};

function drawMap(offsetX = 0, offsetY = 0) {
  const box = panel.querySelector('.pm-tiles');
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H) return;
  const c = project(view.lat, view.lon, view.z);
  const left = c.x - W / 2 - offsetX;
  const top = c.y - H / 2 - offsetY;
  const n = 2 ** view.z;
  const style = isDark() ? 'dark_all' : 'rastertiles/voyager';
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
      const wx = ((tx % n) + n) % n;
      const sub = 'abcd'[(wx + ty) % 4];
      tiles.push(
        `<img alt="" draggable="false" src="https://${sub}.basemaps.cartocdn.com/${style}/${view.z}/${wx}/${ty}@2x.png" style="left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px">`,
      );
    }
  }
  box.innerHTML = tiles.join('');
  const pin = panel.querySelector('.pm-pin');
  const item = items[active];
  if (item) {
    const p = project(item.lat, item.lon, view.z);
    pin.style.left = `${p.x - left}px`;
    pin.style.top = `${p.y - top}px`;
  }
  // An <svg> has no .hidden property; toggle the attribute itself.
  pin.toggleAttribute('hidden', !item);
}

function wireMap() {
  const surface = panel.querySelector('.pm-surface');
  let drag = null;
  surface.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a')) return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    surface.setPointerCapture(e.pointerId);
    surface.classList.add('dragging');
  });
  surface.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    drawMap(drag.dx, drag.dy);
  });
  const end = () => {
    if (!drag) return;
    const c = project(view.lat, view.lon, view.z);
    Object.assign(view, unproject(c.x - drag.dx, c.y - drag.dy, view.z));
    drag = null;
    surface.classList.remove('dragging');
    drawMap();
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  surface.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  panel.querySelector('[data-zoom="in"]').addEventListener('click', () => zoom(1));
  panel.querySelector('[data-zoom="out"]').addEventListener('click', () => zoom(-1));
}

function zoom(step) {
  view.z = Math.max(3, Math.min(18, view.z + step));
  drawMap();
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

function highlight(i, { move = true } = {}) {
  active = i;
  const item = items[i];
  if (item && move) Object.assign(view, { lat: item.lat, lon: item.lon, z: item.zoom });
  render();
  drawMap();
}

function open() {
  if (!panel.hidden) return;
  panel.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (!items.length && bias) Object.assign(view, { lat: bias.lat, lon: bias.lon, z: 12 });
  drawMap();
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
      <div class="pm-surface">
        <div class="pm-tiles"></div>
        <svg class="pm-pin" viewBox="0 0 24 32" aria-hidden="true" hidden><path d="M12 31s10-10.2 10-18A10 10 0 0 0 2 13c0 7.8 10 18 10 18z"/><circle cx="12" cy="12.5" r="3.6"/></svg>
        <div class="pm-zoom"><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button></div>
        <div class="pm-attrib">© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a></div>
      </div>
      <div class="pm-actions"></div>
    </div>`;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'places-list');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  wireMap();

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
  new ResizeObserver(() => !panel.hidden && drawMap()).observe(panel);

  // Rank suggestions around the place the weather is for.
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    const manual = settings?.location?.mode === 'manual' && settings.location.lat != null ? settings.location : null;
    const geo = manual || (await local.get('geo'));
    if (geo?.lat != null) bias = { lat: geo.lat, lon: geo.lon };
  } catch {}
}
