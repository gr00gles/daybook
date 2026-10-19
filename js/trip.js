// Travel time and weather for upcoming events that have a real place. The place is looked up
// with Photon (OpenStreetMap data, no key); drive time comes from the FOSSGIS OSRM server, or
// from TomTom with live traffic when you add a TomTom key; weather comes from Open-Meteo.
import { local, getJSON } from './util.js';
import { lastWeather } from './weather.js';

const GEO_KEY = 'trip:geo';
const ROUTE_KEY = 'trip:routes';
const WX_KEY = 'trip:wx';
const MAX_KM = 250; // farther than this is a trip, or the lookup found the wrong place
const WEATHER_DAYS = 7;
const LEAVE_HOURS = 24;

const info = new Map(); // eventKey -> { wx, leave }
let stamp = '';

export const eventKey = (e) => `${e.id}|${e.start}`;
export const tripInfo = (e) => info.get(eventKey(e));

// Video calls, phone calls and rooms aren't places you drive to.
const VIRTUAL =
  /^(https?:|www\.)|zoom|teams|google meet|meet\.google|webex|skype|whereby|gotomeeting|bluejeans|facetime|discord|slack|hangout|\b(online|virtual|remote|phone|call|dial[- ]?in|tbd|tba|n\/a|none|home)\b/i;
const ROOM = /^(room|rm\.?|conf\b|conference|meeting room|board ?room|office|desk|floor|building|bldg)\b/i;

export function placeOf(location) {
  const parts = String(location || '').split(/;|\n/).map((s) => s.trim());
  return parts.find((p) => p.length >= 4 && !VIRTUAL.test(p) && !ROOM.test(p)) || '';
}

function km(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371;
}

// A small key-value store in chrome.storage.local that forgets its oldest entries.
async function store(key) {
  const map = (await local.get(key)) || {};
  return {
    get: (k) => map[k],
    set: (k, v) => (map[k] = { ...v, at: Date.now() }),
    save: (limit) => {
      const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, limit);
      return local.set(key, Object.fromEntries(entries));
    },
  };
}

// Where you'd leave from: Chrome's location fix if there is a recent one, else the weather's place.
async function origin() {
  const geo = await local.get('geo');
  if (geo?.lat != null && Date.now() - geo.at < 24 * 3600e3) return { lat: +geo.lat, lon: +geo.lon };
  const w = lastWeather();
  return w && Number.isFinite(w.lat) ? { lat: w.lat, lon: w.lon } : null;
}

// Areas, not addresses: fine for weather, useless for a drive time.
const AREA = new Set(['city', 'county', 'state', 'country', 'district', 'locality']);

async function geocode(geo, place, from) {
  const hit = geo.get(place);
  if (hit && Date.now() - hit.at < (hit.miss ? 7 : 60) * 86400e3) return hit.miss ? null : hit;
  const q = new URLSearchParams({ q: place, limit: '5', lang: 'en' });
  if (from) {
    q.set('lat', from.lat);
    q.set('lon', from.lon);
    q.set('location_bias_scale', '0.8');
  }
  const res = await getJSON(`https://photon.komoot.io/api/?${q}`);
  const found = (res.features || [])
    .map((f) => ({ lon: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1], type: f.properties?.type || '' }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({ ...p, km: from ? km(from, p) : 0 }))
    .sort((a, b) => a.km - b.km)[0];
  if (!found || found.km > MAX_KM) {
    geo.set(place, { miss: true });
    return null;
  }
  const entry = { lat: +found.lat.toFixed(5), lon: +found.lon.toFixed(5), area: AREA.has(found.type) };
  geo.set(place, entry);
  return entry;
}

const ll = (p, d = 3) => `${p.lat.toFixed(d)},${p.lon.toFixed(d)}`;

async function tomtom(key, from, to, start) {
  const q = new URLSearchParams({ key, traffic: 'true', travelMode: 'car', routeType: 'fastest' });
  // Live traffic for the next few hours; TomTom's typical traffic for later.
  if (start - Date.now() > 3 * 3600e3) q.set('arriveAt', new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  else q.set('departAt', 'now');
  const res = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${ll(from, 5)}:${ll(to, 5)}/json?${q}`);
  if (!res.ok) throw new Error(`TomTom ${res.status}`);
  const s = (await res.json()).routes?.[0]?.summary;
  if (!s) throw new Error('TomTom found no route');
  return { secs: s.travelTimeInSeconds, meters: s.lengthInMeters, traffic: true };
}

async function osrm(from, to) {
  const res = await getJSON(
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false&steps=false`,
  );
  const r = res.code === 'Ok' ? res.routes?.[0] : null;
  if (!r) throw new Error('No route');
  return { secs: r.duration, meters: r.distance, traffic: false };
}

let tomtomDown = 0; // after a TomTom failure (bad key, limit), skip it for a while

async function route(routes, S, from, to, start) {
  const key = S.travel.tomtomKey.trim();
  const soon = start - Date.now() < 3 * 3600e3;
  if (key && Date.now() - tomtomDown > 30 * 60e3) {
    const k = `tt|${ll(from)}|${ll(to)}|${soon ? 'now' : Math.round(start / 3600e3)}`;
    const hit = routes.get(k);
    if (hit && Date.now() - hit.at < (soon ? 10 : 60) * 60e3) return hit;
    try {
      const r = await tomtom(key, from, to, start);
      routes.set(k, r);
      return r;
    } catch (err) {
      tomtomDown = Date.now();
      console.warn('[daybook] TomTom:', err);
    }
  }
  // Without traffic the drive time only changes when the roads do.
  const k = `osrm|${ll(from)}|${ll(to)}`;
  const hit = routes.get(k);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit;
  const r = await osrm(from, to);
  routes.set(k, r);
  return r;
}

// The hourly forecast for a place: the weather card's own when it's nearby, else its own.
async function forecast(wx, S, place, home) {
  const w = lastWeather();
  if (w && home && km(home, place) < 8) return w.hourly;
  const k = `${ll(place, 2)}|${S.units}`;
  const hit = wx.get(k);
  if (hit && Date.now() - hit.at < 3600e3) return hit.hourly;
  const q = new URLSearchParams({
    latitude: place.lat.toFixed(2),
    longitude: place.lon.toFixed(2),
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: '8',
  });
  if (S.units !== 'C') q.set('temperature_unit', 'fahrenheit');
  const { hourly } = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
  wx.set(k, { hourly });
  return hourly;
}

function hourAt(hourly, t) {
  const s = t / 1000;
  const i = hourly?.time?.findIndex((h) => s >= h && s < h + 3600);
  if (i == null || i < 0) return null;
  return {
    temp: hourly.temperature_2m[i],
    pop: hourly.precipitation_probability?.[i] ?? 0,
    code: hourly.weather_code[i],
    isDay: hourly.is_day?.[i] ?? 1,
  };
}

let running = false;
let again = null;

// Works out weather and leave-by times for the coming week's events. Everything is cached,
// so calling this on every calendar refresh is cheap; onUpdate runs only when something changed.
export async function planTrips(S, events, onUpdate) {
  if (!S.show.travel) return;
  if (running) {
    again = [S, events, onUpdate];
    return;
  }
  running = true;
  try {
    const now = Date.now();
    const list = events
      .filter((e) => !e.allDay && e.end > now && e.start < now + WEATHER_DAYS * 86400e3 && placeOf(e.location))
      .slice(0, 30);
    const from = await origin();
    const [geo, routes, wx] = await Promise.all([store(GEO_KEY), store(ROUTE_KEY), store(WX_KEY)]);
    const next = new Map();
    for (const e of list) {
      const place = placeOf(e.location);
      let to;
      try {
        to = await geocode(geo, place, from);
      } catch (err) {
        console.warn('[daybook] place lookup:', err);
        continue;
      }
      if (!to) continue;
      const out = {};
      try {
        const hour = hourAt(await forecast(wx, S, to, from), e.start);
        if (hour) out.wx = hour;
      } catch (err) {
        console.warn('[daybook] event weather:', err);
      }
      if (from && !to.area && e.start > now && e.start < now + LEAVE_HOURS * 3600e3 && km(from, to) > 0.5) {
        try {
          const r = await route(routes, S, from, to, e.start);
          // A walk around the block doesn't need a leave-by time.
          if (r.meters > 1200) {
            out.leave = { at: e.start - r.secs * 1000 - S.travel.buffer * 60e3, mins: Math.max(1, Math.round(r.secs / 60)), traffic: r.traffic };
          }
        } catch (err) {
          console.warn('[daybook] drive time:', err);
        }
      }
      if (out.wx || out.leave) next.set(eventKey(e), out);
    }
    await Promise.all([geo.save(200), routes.save(80), wx.save(24)]);
    const sig = JSON.stringify([...next]);
    if (sig !== stamp) {
      stamp = sig;
      info.clear();
      for (const [k, v] of next) info.set(k, v);
      onUpdate();
    }
  } finally {
    running = false;
    if (again) {
      const args = again;
      again = null;
      setTimeout(() => planTrips(...args), 0);
    }
  }
}

// "Leave by 2:35", "Leave in 9 min", "Leave now".
export function leaveText(leave, fmt) {
  const mins = Math.round((leave.at - Date.now()) / 60000);
  if (mins <= 0) return { text: 'Leave now', level: 'now' };
  if (mins <= 15) return { text: `Leave in ${mins} min`, level: 'soon' };
  return { text: `Leave by ${fmt(leave.at)}`, level: '' };
}

// Whether any leave-by on screen came from each source, for the credit line.
export const tripSources = () => {
  const all = [...info.values()].filter((v) => v.leave);
  return { osrm: all.some((v) => !v.leave.traffic), tomtom: all.some((v) => v.leave.traffic) };
};
