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
  /^(https?:|www\.)|\b(zoom|(microsoft )?teams( meeting)?|google meet|meet\.google\.com|webex|skype|whereby|gotomeeting|bluejeans|facetime|discord|slack( huddle)?|hangouts?)\b/i;
// Dial-in details ("Phone: +1 555…, PIN 1234") must never be sent to a place lookup.
// Dial-in details ("Phone: +1 555…", "PIN 1234"), or a location that is just "Online" or "Call".
const CALL = /\b(phone|pin|passcode|meeting id|dial[- ]?in|conference id)\b\s*[:#]?\s*[+\d(]|^(online|virtual|remote|call|phone|phone call|conference call|video call|dial[- ]?in|tbd|tba)$/i;
const NOT_A_PLACE = /^(n\/a|none|home|my place|my house|office|work)$/i;
const ROOM = /^(room|rm\.?|conf(erence)? room|meeting room|board ?room|suite|ste\.?|floor|fl\.?|desk|building|bldg\.?)\b/i;

// The drivable part of a location: "Conference Room B, 100 Main St" → "100 Main St".
export function placeOf(location) {
  for (const part of String(location || '').split(/;|\n/)) {
    const p = part.trim();
    if (!p || VIRTUAL.test(p) || CALL.test(p) || NOT_A_PLACE.test(p)) continue;
    const rest = p.split(',').map((x) => x.trim()).filter(Boolean);
    while (rest.length && ROOM.test(rest[0])) rest.shift();
    const place = rest.join(', ');
    if (place.length >= 4 && !NOT_A_PLACE.test(place)) return place;
  }
  return '';
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

// Where you'd leave from: a recent location fix from Chrome (the weather card's, or our own
// when the weather is turned off), else the weather's place or the city picked in Settings.
async function origin(S) {
  const geo = await local.get('geo');
  if (geo?.lat != null && Date.now() - geo.at < 3 * 3600e3) return { lat: +geo.lat, lon: +geo.lon };
  if (S.location.mode !== 'manual') {
    const fix = await new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }),
        () => resolve(null),
        { timeout: 8000, maximumAge: 30 * 60e3 },
      ),
    );
    if (fix) return fix;
  }
  const w = lastWeather();
  if (w && Number.isFinite(w.lat)) return { lat: w.lat, lon: w.lon };
  if (S.location.lat != null) return { lat: +S.location.lat, lon: +S.location.lon };
  return geo?.lat != null ? { lat: +geo.lat, lon: +geo.lon } : null;
}

// Areas, not addresses: fine for weather, useless for a drive time.
const AREA = new Set(['city', 'county', 'state', 'country', 'district', 'locality']);

// Where a place is, looked up near where you are. Without a location, "Joe's Coffee" could be
// anywhere, so nothing is looked up. The answer is remembered per area you're in.
async function geocode(geo, place, from) {
  if (!from) return null;
  const k = `${place}|${from.lat.toFixed(1)},${from.lon.toFixed(1)}`;
  const hit = geo.get(k);
  if (hit && Date.now() - hit.at < (hit.miss ? 7 : 60) * 86400e3) return hit.miss || km(from, hit) > MAX_KM ? null : hit;
  // A low scale lets distance from you count for more than how well known a place is.
  const q = new URLSearchParams({ q: place, limit: '5', lang: 'en', lat: from.lat, lon: from.lon, location_bias_scale: '0.1' });
  const res = await getJSON(`https://photon.komoot.io/api/?${q}`);
  // Photon's own order, best match first; the first one near enough to be the place.
  const found = (res.features || [])
    .map((f) => ({ lon: f.geometry?.coordinates?.[0], lat: f.geometry?.coordinates?.[1], type: f.properties?.type || '' }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .find((p) => km(from, p) <= MAX_KM);
  if (!found) {
    geo.set(k, { miss: true });
    return null;
  }
  const entry = { lat: +found.lat.toFixed(5), lon: +found.lon.toFixed(5), area: AREA.has(found.type) };
  geo.set(k, entry);
  return entry;
}

const ll = (p, d = 3) => `${p.lat.toFixed(d)},${p.lon.toFixed(d)}`;

async function tomtom(key, from, to, start) {
  const q = new URLSearchParams({ key, traffic: 'true', travelMode: 'car', routeType: 'fastest' });
  // Live traffic for the next few hours; TomTom's typical traffic for later.
  if (start - Date.now() > 3 * 3600e3) q.set('arriveAt', new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  else q.set('departAt', 'now');
  const res = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${ll(from, 5)}:${ll(to, 5)}/json?${q}`);
  if (!res.ok) throw Object.assign(new Error(`TomTom ${res.status}`), { status: res.status });
  const s = (await res.json()).routes?.[0]?.summary;
  if (!s) throw new Error('TomTom found no route');
  return { secs: s.travelTimeInSeconds, meters: s.lengthInMeters, traffic: true, live: !q.has('arriveAt') };
}

async function osrm(from, to) {
  const res = await getJSON(
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false&steps=false`,
  );
  const r = res.code === 'Ok' ? res.routes?.[0] : null;
  if (!r) throw new Error('No route');
  return { secs: r.duration, meters: r.distance, traffic: false };
}

let tomtomDown = 0; // after TomTom refuses the key or the day's limit is used up, skip it for a while

async function route(routes, S, from, to, start) {
  const key = S.travel.tomtomKey.trim();
  const soon = start - Date.now() < 3 * 3600e3;
  if (key && Date.now() - tomtomDown > 30 * 60e3) {
    const k = `tt|${ll(from)}|${ll(to)}|${soon ? 'now' : Math.round(start / 3600e3)}`;
    const hit = routes.get(k);
    if (hit && !hit.fail && Date.now() - hit.at < (soon ? 10 : 60) * 60e3) return hit;
    if (!hit?.fail || Date.now() - hit.at > 3600e3) {
      try {
        const r = await tomtom(key, from, to, start);
        routes.set(k, r);
        return r;
      } catch (err) {
        if ([401, 403, 429].includes(err.status)) tomtomDown = Date.now();
        // One place TomTom can't route to (an island, say): try OSRM for it, and not TomTom again for an hour.
        else if (err.status === 400 || err.message === 'TomTom found no route') routes.set(k, { fail: true });
        console.warn('[daybook] TomTom:', err);
      }
    }
  }
  // Without traffic the drive time only changes when the roads do.
  const k = `osrm|${ll(from)}|${ll(to)}`;
  const hit = routes.get(k);
  // A recent failure: no drive time for this place for now (and no new warning).
  if (hit && Date.now() - hit.at < (hit.fail ? hit.retry || 3600e3 : 24 * 3600e3)) return hit.fail ? null : hit;
  try {
    const r = await osrm(from, to);
    routes.set(k, r);
    return r;
  } catch (err) {
    // Only a definite "no route" is remembered; a network hiccup is tried again next time.
    // A definite "no route" is remembered for an hour; a busy server or a hiccup for 10 minutes.
    routes.set(k, err.message === 'No route' || err.status === 400 ? { fail: true } : { fail: true, retry: 10 * 60e3 });
    throw err;
  }
}

// The hourly forecast for a place: the weather card's own when the place is near where that
// forecast is for, else its own.
async function forecast(wx, S, place) {
  const w = lastWeather();
  if (w && Number.isFinite(w.lat) && km({ lat: w.lat, lon: w.lon }, place) < 8) return w.hourly;
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
    const from = await origin(S);
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
        const hour = hourAt(await forecast(wx, S, to), e.start);
        if (hour) out.wx = hour;
      } catch (err) {
        console.warn('[daybook] event weather:', err);
      }
      if (from && !to.area && e.start > now && e.start < now + LEAVE_HOURS * 3600e3 && km(from, to) > 0.5) {
        try {
          const r = await route(routes, S, from, to, e.start);
          // A walk around the block doesn't need a leave-by time.
          if (r && r.meters > 1200) {
            out.leave = { at: e.start - r.secs * 1000 - S.travel.buffer * 60e3, mins: Math.max(1, Math.round(r.secs / 60)), traffic: r.traffic, live: Boolean(r.live) };
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

// What the travel info on screen came from, for the credit line.
export const tripSources = () => {
  const all = [...info.values()];
  return {
    places: all.length > 0,
    osrm: all.some((v) => v.leave && !v.leave.traffic),
    tomtom: all.some((v) => v.leave?.traffic),
    weather: all.some((v) => v.wx),
  };
};
