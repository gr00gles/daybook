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
  const byId = new Map();
  const replaced = new Set();
  for (const [k, r] of results.entries()) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value.features || []) {
      // A storm warning drawn as a polygon lists every county it touches; the point query
      // already tells whether the polygon covers you. From the zone query, keep only alerts
      // issued for whole zones, like Red Flag Warnings.
      // (If the point query failed, the zone query's polygons are the best there is.)
      if (k > 0 && f.geometry && results[0].status === 'fulfilled') continue;
      const p = f.properties || {};
      // An update names the alerts it replaces.
      for (const ref of p.references || []) if (ref.identifier) replaced.add(ref.identifier);
      if ((p.status && p.status !== 'Actual') || p.messageType === 'Cancel') continue;
      // `ends` is when the hazard is over; `expires` only when this message lapses, and
      // "until further notice" alerts have no end at all.
      const ends = Date.parse(p.ends || '') || 0;
      const expires = Date.parse(p.expires || '') || 0;
      if ((ends || expires) && (ends || expires) < Date.now()) continue;
      const id = p.id || f.id || `${p.event}|${p.sent}`;
      const sent = Date.parse(p.sent || '') || 0;
      byId.set(id, {
        id,
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
  const list = [...byId.values()].filter((a) => !replaced.has(a.id)).sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || b.sent - a.sent);
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

let painted = '';

function render() {
  const box = $('#wx-alerts');
  const chip = $('#nw-alert');
  const list = current.list;
  const html = list
    .slice(0, 3)
    .map(
      (a, i) => `<details class="wx-alert s-${SEVERITY[a.severity] || 'minor'}" id="wx-alert-${i}" data-id="${esc(a.id)}">
          <summary>${icon('alert')}<span><strong>${esc(a.event)}</strong>${esc(until(a))}</span></summary>
          ${a.headline ? `<p class="wx-alert-head">${esc(a.headline)}</p>` : ''}
          ${a.description ? `<p class="wx-alert-text">${esc(a.description)}</p>` : ''}
          ${a.instruction ? `<p class="wx-alert-text"><strong>What to do:</strong> ${esc(a.instruction)}</p>` : ''}
          <a class="foot-link" href="https://forecast.weather.gov/MapClick.php?lat=${current.lat}&lon=${current.lon}">${icon('external')}National Weather Service</a>
        </details>`,
    )
    .join('');
  // Refreshes come every minute; leave the banners alone (and open ones open) unless they changed.
  if (box && html !== painted) {
    const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    box.innerHTML = html;
    for (const d of box.querySelectorAll('details')) d.open = open.has(d.dataset.id);
    painted = html;
  }
  if (chip) {
    const top = list[0];
    chip.hidden = !top;
    if (top) {
      chip.className = `nw-alert s-${SEVERITY[top.severity] || 'minor'}`;
      chip.innerHTML = `${icon('alert')}<span>${esc(top.event)}${list.length > 1 ? ` +${list.length - 1}` : ''}</span>`;
    }
  }
}

let wanted = '';

export function refreshAlerts(S, weather, force = false) {
  settingsRef = S;
  if (!S.show.alerts || !weather || weather.lat == null || Number.isNaN(weather.lat)) return;
  const { lat, lon } = weather;
  const sig = hash([lat.toFixed(3), lon.toFixed(3)]);
  // A new place: drop the old place's alerts rather than show them under the new weather.
  if (sig !== wanted && current.sig && current.sig !== sig) {
    current = { list: [], lat: 0, lon: 0 };
    render();
  }
  wanted = sig;
  return cached({
    key: 'nws',
    sig,
    maxAge: 5 * 60e3,
    force,
    fetch: () => fetchAlerts(lat, lon),
    render: (data) => {
      // An answer for a place we've since moved away from.
      if (sig !== wanted) return;
      // Keep showing the last alerts we had if a refresh fails.
      if (data) current = { sig, list: data.list.filter((a) => !a.ends || a.ends > Date.now()), lat: lat.toFixed(4), lon: lon.toFixed(4) };
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
