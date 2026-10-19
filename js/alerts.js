// Severe weather alerts from the US National Weather Service (api.weather.gov, no key).
// Outside the US the API has no data for the location, and nothing is shown.
import { $, esc, local, cached, hash, fmtTime } from './util.js';
import { icon } from './icons.js';

const POINT_KEY = 'nws:point';
const SEVERITY = { Extreme: 'critical', Severe: 'serious', Moderate: 'warning', Minor: 'minor', Unknown: 'minor' };
const RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
const geo = { headers: { Accept: 'application/geo+json' } };

let current = { list: [], lat: 0, lon: 0 };
let settingsRef;

// The forecast zone, county and fire-weather zone for a point, looked up once per place.
// Zone alerts (like Red Flag warnings) can miss a point query, so both are asked.
async function zonesFor(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const stored = await local.get(POINT_KEY);
  if (stored?.key === key) return stored.zones;
  const res = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, geo);
  if (res.status === 404) {
    await local.set(POINT_KEY, { key, zones: null });
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = (await res.json()).properties || {};
  const id = (url) => (url || '').split('/').pop();
  const zones = [p.forecastZone, p.county, p.fireWeatherZone].map(id).filter(Boolean);
  await local.set(POINT_KEY, { key, zones });
  return zones;
}

async function fetchAlerts(lat, lon) {
  const zones = await zonesFor(lat, lon);
  if (!zones) return { outside: true, list: [] };
  const urls = [`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`];
  if (zones.length) urls.push(`https://api.weather.gov/alerts/active?zone=${zones.join(',')}`);
  const results = await Promise.allSettled(
    urls.map((u) => fetch(u, geo).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))),
  );
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  const byEvent = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value.features || []) {
      const p = f.properties || {};
      if ((p.status && p.status !== 'Actual') || p.messageType === 'Cancel') continue;
      const ends = Date.parse(p.ends || p.expires || '') || 0;
      if (ends && ends < Date.now()) continue;
      // Updates to the same warning arrive as new alerts; keep the latest one per event.
      const sent = Date.parse(p.sent || '') || 0;
      const prev = byEvent.get(p.event);
      if (prev && prev.sent >= sent) continue;
      byEvent.set(p.event, {
        event: p.event || 'Weather alert',
        headline: p.headline || '',
        severity: p.severity || 'Unknown',
        ends,
        sent,
        description: unwrap(p.description || ''),
        instruction: unwrap(p.instruction || ''),
      });
    }
  }
  const list = [...byEvent.values()].sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || b.sent - a.sent);
  return { outside: false, list };
}

// NWS text is hard-wrapped at about 70 characters with blank lines between paragraphs.
const unwrap = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

const until = (a) => (a.ends ? ` until ${new Date(a.ends).toLocaleString(undefined, { weekday: sameDay(a.ends) ? undefined : 'short', hour: 'numeric', minute: '2-digit', hour12: !settingsRef?.clock24 })}` : '');
const sameDay = (t) => new Date(t).toDateString() === new Date().toDateString();

function render() {
  const box = $('#wx-alerts');
  const chip = $('#nw-alert');
  const list = current.list;
  if (box)
    box.innerHTML = list
      .slice(0, 3)
      .map(
        (a, i) => `<details class="wx-alert s-${SEVERITY[a.severity] || 'minor'}" id="wx-alert-${i}">
          <summary>${icon('alert')}<span><strong>${esc(a.event)}</strong>${esc(until(a))}</span></summary>
          ${a.headline ? `<p class="wx-alert-head">${esc(a.headline)}</p>` : ''}
          ${a.description ? `<p class="wx-alert-text">${esc(a.description)}</p>` : ''}
          ${a.instruction ? `<p class="wx-alert-text"><strong>What to do:</strong> ${esc(a.instruction)}</p>` : ''}
          <a class="foot-link" href="https://forecast.weather.gov/MapClick.php?lat=${current.lat}&lon=${current.lon}">${icon('external')}National Weather Service</a>
        </details>`,
      )
      .join('');
  if (chip) {
    const top = list[0];
    chip.hidden = !top;
    if (top) {
      chip.className = `nw-alert s-${SEVERITY[top.severity] || 'minor'}`;
      chip.innerHTML = `${icon('alert')}<span>${esc(top.event)}${list.length > 1 ? ` +${list.length - 1}` : ''}</span>`;
    }
  }
}

export function refreshAlerts(S, weather, force = false) {
  settingsRef = S;
  if (!S.show.alerts || !weather || weather.lat == null || Number.isNaN(weather.lat)) return;
  const { lat, lon } = weather;
  return cached({
    key: 'nws',
    sig: hash([lat.toFixed(3), lon.toFixed(3)]),
    maxAge: 5 * 60e3,
    force,
    fetch: () => fetchAlerts(lat, lon),
    render: (data) => {
      // Keep showing the last alerts we had if a refresh fails.
      if (data) current = { list: data.list.filter((a) => !a.ends || a.ends > Date.now()), lat: lat.toFixed(4), lon: lon.toFixed(4) };
      render();
    },
  });
}

export function initAlerts() {
  $('#nw-alert')?.addEventListener('click', () => {
    const first = $('#wx-alert-0');
    if (!first) return;
    first.open = true;
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
