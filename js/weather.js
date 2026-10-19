// Weather from Open-Meteo (free, no key). Location comes from Chrome's geolocation or a
// city you pick in Settings.
import { $, esc, cached, hash, local, getJSON, fmtTime, fmtHour, updatedText, errorText } from './util.js';
import { weatherIcon, icon } from './icons.js';

const WMO = {
  0: ['Clear', 'clear'], 1: ['Mostly clear', 'clear'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloud'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'drizzle'], 57: ['Freezing drizzle', 'drizzle'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'],
  85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorms', 'storm'], 96: ['Thunderstorms with hail', 'storm'], 99: ['Thunderstorms with hail', 'storm'],
};

export function describe(code, isDay = 1) {
  const [label, kind] = WMO[code] || ['Cloudy', 'cloud'];
  let glyph = kind;
  if (!isDay && kind === 'clear') glyph = 'moon';
  if (!isDay && kind === 'partly') glyph = 'moon-partly';
  return { label, glyph };
}

export function todayIndex(daily) {
  const now = Date.now() / 1000;
  const i = daily.time.findIndex((t, k) => now >= t && now < (daily.time[k + 1] ?? t + 86400));
  return i < 0 ? 0 : i;
}

const round = (v) => (v == null ? '–' : Math.round(v));
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function uvLabel(uv) {
  if (uv == null) return '';
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

function aqiStatus(aqi) {
  if (aqi <= 50) return ['good', 'Good'];
  if (aqi <= 100) return ['warning', 'Moderate'];
  if (aqi <= 150) return ['serious', 'Sensitive groups'];
  if (aqi <= 200) return ['critical', 'Unhealthy'];
  if (aqi <= 300) return ['critical', 'Very unhealthy'];
  return ['critical', 'Hazardous'];
}

async function reverseGeocode(lat, lon) {
  try {
    const r = await getJSON(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
    );
    const place = r.city || r.locality || '';
    const region = r.countryCode === 'US' ? r.principalSubdivisionCode?.replace('US-', '') : r.countryName;
    return [place, region].filter(Boolean).join(', ') || 'Your location';
  } catch {
    return 'Your location';
  }
}

async function locate(S) {
  if (S.location.mode === 'manual' && S.location.lat != null) return S.location;
  const last = await local.get('geo');
  if (last && Date.now() - last.at < 30 * 60e3) return last;
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 30 * 60e3 }),
    );
    const lat = +pos.coords.latitude.toFixed(3);
    const lon = +pos.coords.longitude.toFixed(3);
    const moved = !last || Math.abs(last.lat - lat) + Math.abs(last.lon - lon) > 0.05;
    const geo = { lat, lon, name: moved ? await reverseGeocode(lat, lon) : last.name, at: Date.now() };
    await local.set('geo', geo);
    return geo;
  } catch {
    if (last) return last;
    if (S.location.lat != null) return S.location;
    throw new Error('no-location');
  }
}

async function fetchWeather(loc, units) {
  const imperial = units !== 'C';
  const q = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '8',
  });
  if (imperial) {
    q.set('temperature_unit', 'fahrenheit');
    q.set('wind_speed_unit', 'mph');
  }
  const aq = new URLSearchParams({ latitude: loc.lat, longitude: loc.lon, current: 'us_aqi', timezone: 'auto' });
  const [wx, air] = await Promise.allSettled([
    getJSON(`https://api.open-meteo.com/v1/forecast?${q}`),
    getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${aq}`),
  ]);
  if (wx.status === 'rejected') throw wx.reason;
  const w = wx.value;
  return {
    place: loc.name || 'Your location',
    wind: imperial ? 'mph' : 'km/h',
    current: w.current,
    hourly: w.hourly,
    daily: w.daily,
    aqi: air.status === 'fulfilled' ? air.value.current?.us_aqi ?? null : null,
  };
}

let last = null;
let settingsRef;
export const lastWeather = () => last;

export async function refreshWeather(S, force, onData) {
  settingsRef = S;
  const apply = (data, meta) => {
    if (data) {
      last = data;
      onData(data);
      renderNow(data);
      renderCard(data, meta);
    } else renderError(meta.error);
  };
  // Paint whatever is stored before asking for a location fix, which can take seconds.
  const stored = await local.get('cache:weather');
  if (stored && !last) apply(stored.data, { at: stored.at });
  let loc;
  try {
    loc = await locate(S);
  } catch {
    if (!stored) renderNoLocation();
    return;
  }
  return cached({
    key: 'weather',
    sig: hash([loc.lat, loc.lon, S.units]),
    maxAge: 15 * 60e3,
    force,
    fetch: () => fetchWeather(loc, S.units),
    render: apply,
  });
}

function renderNoLocation() {
  $('#now-weather').innerHTML = `<button class="btn ghost" type="button" data-open-settings="location">${icon('locate')}Set your location for weather</button>`;
  $('#weather-body').innerHTML = `<div class="notice setup"><p>Chrome didn't share a location. Pick your city and the forecast appears here.</p><button class="btn small primary" type="button" data-open-settings="location">Choose a city</button></div>`;
}

function renderError(err) {
  $('#weather-body').innerHTML = `<p class="notice warn">Weather isn't loading: ${esc(errorText(err))}. It will retry in a minute.</p>`;
}

function renderNow(d) {
  const c = d.current;
  const i = todayIndex(d.daily);
  const { label, glyph } = describe(c.weather_code, c.is_day);
  $('#now-weather').innerHTML = `
    <div class="nw-main">
      <span class="nw-icon">${weatherIcon(glyph)}</span>
      <span class="nw-temp">${round(c.temperature_2m)}°</span>
      <div class="nw-text">
        <div class="nw-cond">${esc(label)}</div>
        <div class="nw-meta">H ${round(d.daily.temperature_2m_max[i])}° · L ${round(d.daily.temperature_2m_min[i])}° · Feels ${round(c.apparent_temperature)}°</div>
        <div class="nw-place">${icon('pin')}${esc(d.place)}</div>
      </div>
    </div>
    <div class="suntrack" id="suntrack"></div>`;
  renderSun();
}

const dur = (ms) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export function renderSun() {
  const el = $('#suntrack');
  if (!el || !last) return;
  const h24 = settingsRef?.clock24;
  const dly = last.daily;
  const i = todayIndex(dly);
  const rise = dly.sunrise[i] * 1000;
  const set = dly.sunset[i] * 1000;
  const len = set - rise;
  const prev = i > 0 ? (dly.sunset[i - 1] - dly.sunrise[i - 1]) * 1000 : null;
  const now = Date.now();
  const f = (now - rise) / len;
  const up = f >= 0 && f <= 1;
  const W = 248, H = 74, cx = W / 2, cy = 54, rx = 104, ry = 40;
  const pt = (t) => [cx - rx * Math.cos(Math.PI * t), cy - ry * Math.sin(Math.PI * t)];
  const arc = (t0, t1) => {
    const pts = [];
    for (let k = 0; k <= 48; k++) pts.push(pt(t0 + ((t1 - t0) * k) / 48).map((v) => v.toFixed(1)).join(' '));
    return `M${pts.join('L')}`;
  };
  const [sx, sy] = pt(Math.min(1, Math.max(0, f)));
  let caption;
  if (up) {
    const diff = prev == null ? 0 : Math.round((len - prev) / 60000);
    caption = `${dur(len)} of daylight${diff ? ` · ${Math.abs(diff)}m ${diff > 0 ? 'longer' : 'shorter'}` : ''}`;
  } else if (now < rise) caption = `Sunrise at ${fmtTime(rise, h24)}`;
  else caption = dly.sunrise[i + 1] ? `Sunrise tomorrow at ${fmtTime(dly.sunrise[i + 1] * 1000, h24)}` : 'After sunset';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sunrise ${fmtTime(rise, h24)}, sunset ${fmtTime(set, h24)}">
      <path d="${arc(0, 1)}" class="st-path"/>
      ${up ? `<path d="${arc(0, f)}" class="st-done"/>` : ''}
      <line x1="6" x2="${W - 6}" y1="${cy}" y2="${cy}" class="st-horizon"/>
      ${up ? `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6.5" class="st-sun"/>` : ''}
      <text x="${cx - rx}" y="${H - 3}" class="st-label" text-anchor="middle">${fmtTime(rise, h24)}</text>
      <text x="${cx + rx}" y="${H - 3}" class="st-label" text-anchor="middle">${fmtTime(set, h24)}</text>
    </svg>
    <div class="st-caption">${caption}</div>`;
}

function renderCard(d, meta) {
  const body = $('#weather-body');
  $('#weather-place').textContent = d.place;
  $('#weather-updated').textContent = meta.error ? "couldn't refresh" : updatedText(meta.at);
  const c = d.current;
  const i = todayIndex(d.daily);
  const dly = d.daily;
  const days = [];
  for (let k = i; k < Math.min(i + 7, dly.time.length); k++) days.push(k);
  const lo = Math.min(...days.map((k) => dly.temperature_2m_min[k]));
  const hi = Math.max(...days.map((k) => dly.temperature_2m_max[k]));
  const pct = (t) => ((t - lo) / (hi - lo || 1)) * 100;
  const week = days
    .map((k) => {
      const name = k === i ? 'Today' : new Date(dly.time[k] * 1000).toLocaleDateString(undefined, { weekday: 'short' });
      const { label, glyph } = describe(dly.weather_code[k], 1);
      const pop = dly.precipitation_probability_max[k];
      const tmin = dly.temperature_2m_min[k];
      const tmax = dly.temperature_2m_max[k];
      const nowDot = k === i ? `<span class="range-now" style="left:${pct(c.temperature_2m)}%" title="Now ${round(c.temperature_2m)}°"></span>` : '';
      return `<li class="wk-row" title="${esc(label)}">
        <span class="wk-day">${name}</span>
        <span class="wk-icon">${weatherIcon(glyph)}</span>
        <span class="wk-pop">${pop >= 10 ? `${icon('drop', 'drop')}${pop}%` : ''}</span>
        <span class="wk-lo">${round(tmin)}°</span>
        <span class="range"><span class="range-fill" style="left:${pct(tmin)}%; right:${100 - pct(tmax)}%"></span>${nowDot}</span>
        <span class="wk-hi">${round(tmax)}°</span>
      </li>`;
    })
    .join('');

  const uv = dly.uv_index_max[i];
  const [aqiState, aqiText] = d.aqi != null ? aqiStatus(d.aqi) : [];
  const facts = [
    ['Feels like', `${round(c.apparent_temperature)}°`],
    ['Humidity', `${round(c.relative_humidity_2m)}%`],
    ['Wind', `${round(c.wind_speed_10m)} ${d.wind} ${COMPASS[Math.round(c.wind_direction_10m / 45) % 8]}`, c.wind_gusts_10m > c.wind_speed_10m + 5 ? `gusts ${round(c.wind_gusts_10m)}` : ''],
    ['UV today', `${uv == null ? '–' : Math.round(uv)}`, uvLabel(uv)],
    ...(d.aqi != null ? [['Air quality', `${Math.round(d.aqi)}`, `<span class="status s-${aqiState}">${aqiText}</span>`]] : []),
  ];

  body.innerHTML = `
    <div class="hourly" id="wx-hourly"><div class="hourly-tip" id="wx-tip" hidden></div></div>
    <ol class="week">${week}</ol>
    <dl class="facts">${facts.map(([k, v, sub]) => `<div><dt>${k}</dt><dd>${v}${sub ? `<small>${sub}</small>` : ''}</dd></div>`).join('')}</dl>
    <p class="credit">Weather data by <a href="https://open-meteo.com/">Open-Meteo.com</a></p>`;
  drawHourly();
}

let hourlyObserver;

function drawHourly() {
  const box = $('#wx-hourly');
  if (!box || !last) return;
  if (!hourlyObserver) {
    let w = 0;
    hourlyObserver = new ResizeObserver(([entry]) => {
      const nw = Math.round(entry.contentRect.width);
      if (nw && Math.abs(nw - w) > 4) {
        w = nw;
        drawHourly();
      }
    });
  }
  hourlyObserver.disconnect();
  hourlyObserver.observe(box);

  const h24 = settingsRef?.clock24;
  const h = last.hourly;
  const nowS = Date.now() / 1000;
  let start = h.time.findIndex((t) => t + 3600 > nowS);
  if (start < 0) start = 0;
  const idx = [];
  for (let k = start; k < Math.min(start + 25, h.time.length); k++) idx.push(k);
  if (idx.length < 2) return;
  const temps = idx.map((k) => h.temperature_2m[k]);
  const probs = idx.map((k) => h.precipitation_probability[k] ?? 0);

  const W = Math.max(240, Math.round(box.clientWidth));
  const padX = 14, top = 22, plotH = 86, gap = 14, barH = 26, labelH = 18;
  const H = top + plotH + gap + barH + labelH;
  const n = idx.length;
  const step = (W - padX * 2) / (n - 1);
  const x = (k) => padX + k * step;
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const span = Math.max(4, tMax - tMin);
  const y = (t) => top + (1 - (t - (tMin - span * 0.12)) / (span * 1.24)) * plotH;
  const line = temps.map((t, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(t).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)} ${top + plotH}L${x(0).toFixed(1)} ${top + plotH}Z`;
  const kMax = temps.indexOf(tMax), kMin = temps.indexOf(tMin);
  const anchor = (k) => (k < 2 ? 'start' : k > n - 3 ? 'end' : 'middle');
  const base = top + plotH + gap + barH;
  const bw = Math.max(2, step - 3);
  const bars = probs
    .map((p, k) => {
      if (!p) return '';
      const bh = Math.max(2, (p / 100) * barH);
      const r = Math.min(2, bw / 2, bh / 2);
      const x0 = x(k) - bw / 2;
      return `<path class="pop-bar" d="M${x0.toFixed(1)} ${base}V${(base - bh + r).toFixed(1)}q0 ${-r} ${r} ${-r}h${(bw - 2 * r).toFixed(1)}q${r} 0 ${r} ${r}V${base}Z"/>`;
    })
    .join('');
  const ticks = idx
    .map((k, j) => (j % 3 === 0 ? `<text x="${x(j).toFixed(1)}" y="${H - 4}" class="ax" text-anchor="${anchor(j)}">${j === 0 ? 'Now' : fmtHour(h.time[k] * 1000, h24)}</text>` : ''))
    .join('');
  const maxPop = Math.max(...probs);
  const label = (k, t, above) =>
    `<text x="${x(k).toFixed(1)}" y="${(y(t) + (above ? -9 : 17)).toFixed(1)}" class="val" text-anchor="${anchor(k)}">${round(t)}°</text>`;

  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature for the next 24 hours, from ${round(tMin)}° to ${round(tMax)}°">
      <defs><linearGradient id="tempfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--temp)" stop-opacity=".22"/><stop offset="1" stop-color="var(--temp)" stop-opacity="0"/></linearGradient></defs>
      <line x1="${padX}" x2="${W - padX}" y1="${top + plotH}" y2="${top + plotH}" class="grid"/>
      <line x1="${padX}" x2="${W - padX}" y1="${base}" y2="${base}" class="grid"/>
      <path d="${area}" fill="url(#tempfill)"/>
      <path d="${line}" class="temp-line"/>
      ${kMax > 2 ? label(kMax, tMax, true) : ''}
      ${kMin > 2 && kMin !== kMax ? label(kMin, tMin, false) : ''}
      <circle cx="${x(0)}" cy="${y(temps[0]).toFixed(1)}" r="4.5" class="temp-now"/>
      ${label(0, temps[0], temps[0] >= (tMin + tMax) / 2 ? false : true)}
      <text x="${padX}" y="${top + plotH + gap - 2}" class="ax cap">${maxPop ? `Chance of rain · peak ${maxPop}%` : 'No rain expected'}</text>
      ${bars}
      ${ticks}
      <line class="cross" id="wx-cross" y1="${top - 6}" y2="${base}" x1="0" x2="0" visibility="hidden"/>
      <circle class="cross-dot" id="wx-cross-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>
    </svg><div class="hourly-tip" id="wx-tip" hidden></div>`;

  const svg = box.querySelector('svg');
  const tip = $('#wx-tip');
  const cross = $('#wx-cross');
  const crossDot = $('#wx-cross-dot');
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    crossDot.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const j = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - rect.left - padX) / step)));
    const k = idx[j];
    cross.setAttribute('x1', x(j));
    cross.setAttribute('x2', x(j));
    cross.setAttribute('visibility', 'visible');
    crossDot.setAttribute('cx', x(j));
    crossDot.setAttribute('cy', y(temps[j]));
    crossDot.setAttribute('visibility', 'visible');
    const { label: cond } = describe(h.weather_code[k], h.is_day[k]);
    tip.innerHTML = `<strong>${j === 0 ? 'Now' : fmtTime(h.time[k] * 1000, h24)}</strong><span>${round(temps[j])}° · ${esc(cond)}</span><span>${probs[j]}% chance of rain</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(W - tw, Math.max(0, x(j) - tw / 2))}px`;
  });
}
