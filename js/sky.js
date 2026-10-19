// The moon's phase and the next holidays, worked out on this computer. US holidays are
// computed; other countries' public holidays come from Nager.Date (no key).
import { $, esc, local, startOfDay, addDays } from './util.js';

// ---- Moon -------------------------------------------------------------------------------
// Times of new moon, quarters and full moon from Meeus, Astronomical Algorithms ch. 49,
// with the main periodic terms: good to a few minutes.

const rad = Math.PI / 180;
const sin = (deg) => Math.sin(deg * rad);
const cos = (deg) => Math.cos(deg * rad);
const fromJd = (jd) => (jd - 2440587.5) * 86400000;
const toK = (ms) => ((ms / 86400000 + 2440587.5 - 2451550.09766) / 29.530588861);

// q: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter.
function phaseTime(k, q) {
  k = Math.floor(k) + q;
  const T = k / 1236.85;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T ** 2 - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T ** 2;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T ** 2 - 0.00000011 * T ** 3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T ** 2 + 0.00001238 * T ** 3 - 0.000000058 * T ** 4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T ** 2 - 0.00000227 * T ** 3 + 0.000000011 * T ** 4;
  const O = 124.7746 - 1.56375588 * k + 0.0020672 * T ** 2 + 0.00000215 * T ** 3;
  if (q === 0 || q === 0.5) {
    const [a, b, c, d, e, f, g] = q === 0
      ? [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208]
      : [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209];
    jde += a * sin(Mp) + b * E * sin(M) + c * sin(2 * Mp) + d * sin(2 * F) + e * E * sin(Mp - M) + f * E * sin(Mp + M) + g * E * E * sin(2 * M)
      - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M) - 0.00042 * sin(3 * Mp)
      + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F) - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(O);
  } else {
    jde += -0.62801 * sin(Mp) + 0.17172 * E * sin(M) - 0.01183 * E * sin(Mp + M) + 0.00862 * sin(2 * Mp) + 0.00804 * sin(2 * F)
      + 0.00454 * E * sin(Mp - M) + 0.00204 * E * E * sin(2 * M) - 0.0018 * sin(Mp - 2 * F) - 0.0007 * sin(Mp + 2 * F)
      - 0.0004 * sin(3 * Mp) - 0.00034 * E * sin(2 * Mp - M) + 0.00032 * E * sin(M + 2 * F) + 0.00032 * E * sin(M - 2 * F)
      - 0.00028 * E * E * sin(Mp + 2 * M) + 0.00027 * E * sin(2 * Mp + M) - 0.00017 * sin(O);
    const W = 0.00306 - 0.00038 * E * cos(M) + 0.00026 * cos(Mp) - 0.00002 * cos(Mp - M) + 0.00002 * cos(Mp + M) + 0.00002 * cos(2 * F);
    jde += q === 0.25 ? W : -W;
  }
  return fromJd(jde);
}

const PHASES = [
  [0, 'New moon'],
  [0.25, 'First quarter'],
  [0.5, 'Full moon'],
  [0.75, 'Last quarter'],
];

// The principal phases around a moment, oldest first.
function phasesAround(t) {
  const k0 = Math.floor(toK(t)) - 1;
  const list = [];
  for (let k = k0; k <= k0 + 2; k++) for (const [q, name] of PHASES) list.push({ q, name, at: phaseTime(k, q) });
  return list.sort((a, b) => a.at - b.at);
}

export function moonNow(t = Date.now()) {
  const list = phasesAround(t);
  // Position in the cycle (0 new … 0.5 full … 1 new), exact at each principal phase.
  const prev = list.filter((p) => p.at <= t).pop();
  const next = list.find((p) => p.at > t);
  const f = prev.q + (0.25 * (t - prev.at)) / (next.at - prev.at);
  const lit = (1 - Math.cos(2 * Math.PI * f)) / 2;
  // A principal phase names the whole local day it falls on.
  const today = startOfDay(t);
  const onToday = list.find((p) => startOfDay(p.at) === today);
  let name;
  if (onToday) name = onToday.name;
  else if (f < 0.25) name = 'Waxing crescent';
  else if (f < 0.5) name = 'Waxing gibbous';
  else if (f < 0.75) name = 'Waning gibbous';
  else name = 'Waning crescent';
  const nextFull = list.find((p) => p.q === 0.5 && startOfDay(p.at) > today);
  const nextNewDay = list.find((p) => p.q === 0 && startOfDay(p.at) > today);
  return { f, lit, name, nextFull: nextFull?.at, nextNew: nextNewDay?.at };
}

// The lit part of the disc: the bright limb plus the terminator, a half-ellipse.
export function moonSvg(f, size = 30, south = false) {
  const r = size / 2 - 1;
  const c = size / 2;
  const waxing = f < 0.5;
  const rx = Math.abs(r * Math.cos(2 * Math.PI * f));
  const bulgesOut = Math.cos(2 * Math.PI * f) > 0; // crescent when waxing, gibbous when waning
  const limb = waxing ? 1 : 0;
  const term = waxing ? (bulgesOut ? 0 : 1) : bulgesOut ? 1 : 0;
  const top = `${c} ${(c - r).toFixed(2)}`;
  const bottom = `${c} ${(c + r).toFixed(2)}`;
  const lit = `M${top}A${r} ${r} 0 0 ${limb} ${bottom}A${rx.toFixed(2)} ${r} 0 0 ${term} ${top}Z`;
  return `<svg class="moon-disc" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <g${south ? ` transform="matrix(-1 0 0 1 ${size} 0)"` : ''}>
      <circle cx="${c}" cy="${c}" r="${r}" class="moon-dark"/>
      <path d="${lit}" class="moon-lit"/>
    </g>
  </svg>`;
}

const dayName = (t) => {
  const days = Math.round((startOfDay(t) - startOfDay()) / 86400000);
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function renderMoon(lat) {
  const el = $('#moon');
  if (!el) return;
  const m = moonNow();
  const pct = Math.round(m.lit * 100);
  const upcoming = [m.nextFull && ['Full moon', m.nextFull], m.nextNew && ['New moon', m.nextNew]].filter(Boolean).sort((a, b) => a[1] - b[1])[0];
  const next = /full|new/i.test(m.name) ? '' : upcoming ? `${upcoming[0]} ${dayName(upcoming[1])}` : '';
  el.innerHTML = `${moonSvg(m.f, 26, lat < 0)}<span class="moon-text"><span class="moon-name">${esc(m.name)}</span><span class="moon-sub">${pct}% lit${next ? ` · ${esc(next)}` : ''}</span></span>`;
  el.title = `${m.name}, ${pct}% of the moon is lit`;
}

// ---- Holidays ---------------------------------------------------------------------------

const nth = (y, m, weekday, n) => {
  // n-th weekday of a month; n = -1 for the last one.
  if (n > 0) {
    const first = new Date(y, m, 1).getDay();
    return new Date(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7).getTime();
  }
  const last = new Date(y, m + 1, 0);
  return new Date(y, m, last.getDate() - ((last.getDay() - weekday + 7) % 7)).getTime();
};

// Anonymous Gregorian computus.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month, day).getTime();
}

function usHolidays(y) {
  const d = (m, day) => new Date(y, m, day).getTime();
  return [
    [d(0, 1), "New Year's Day"],
    [nth(y, 0, 1, 3), 'Martin Luther King Jr. Day'],
    [d(1, 14), "Valentine's Day"],
    [nth(y, 1, 1, 3), "Presidents' Day"],
    [d(2, 17), "St. Patrick's Day"],
    [easter(y), 'Easter'],
    [nth(y, 4, 0, 2), "Mother's Day"],
    [nth(y, 4, 1, -1), 'Memorial Day'],
    [nth(y, 5, 0, 3), "Father's Day"],
    [d(5, 19), 'Juneteenth'],
    [d(6, 4), 'Independence Day'],
    [nth(y, 8, 1, 1), 'Labor Day'],
    [nth(y, 9, 1, 2), 'Columbus Day'],
    [d(9, 31), 'Halloween'],
    [d(10, 11), 'Veterans Day'],
    [nth(y, 10, 4, 4), 'Thanksgiving'],
    [d(11, 24), 'Christmas Eve'],
    [d(11, 25), 'Christmas'],
    [d(11, 31), "New Year's Eve"],
  ].map(([at, name]) => ({ at, name }));
}

// Days the clocks change in this computer's time zone.
function clockChanges(y) {
  const out = [];
  let prev = new Date(y, 0, 1).getTimezoneOffset();
  for (let t = new Date(y, 0, 2).getTime(); new Date(t).getFullYear() === y; t = addDays(t, 1)) {
    const off = new Date(t).getTimezoneOffset();
    if (off !== prev) out.push({ at: addDays(t, -1), name: off > prev ? 'Clocks go back an hour' : 'Clocks go forward an hour', clock: true });
    prev = off;
  }
  return out;
}

const region = () => {
  try {
    return new Intl.Locale(navigator.language || 'en-US').maximize().region || 'US';
  } catch {
    return 'US';
  }
};

async function publicHolidays(country, y) {
  const key = `holidays:${country}:${y}`;
  const stored = await local.get(key);
  if (stored && Date.now() - stored.at < 30 * 86400e3) return stored.list;
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/${country}`);
    // 204/404: Nager.Date doesn't cover this country.
    const raw = res.ok && res.status !== 204 ? await res.json() : [];
    const list = raw
      .filter((h) => h.global !== false && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
      .map((h) => {
        const [yy, mm, dd] = h.date.split('-').map(Number);
        return { at: new Date(yy, mm - 1, dd).getTime(), name: String(h.localName || h.name).slice(0, 60) };
      });
    await local.set(key, { at: Date.now(), list });
    return list;
  } catch {
    return stored?.list || [];
  }
}

const years = new Map(); // year -> list
const loading = new Set();

async function loadYear(y) {
  const country = region();
  const list = [...(country === 'US' ? usHolidays(y) : await publicHolidays(country, y)), ...clockChanges(y)];
  years.set(y, list.sort((a, b) => a.at - b.at));
}

// Loads this year and next (and any years the month view flips to), then calls back.
export function loadHolidays(onReady, ...extraYears) {
  const y = new Date().getFullYear();
  const want = [y, y + 1, ...extraYears].filter((v, i, a) => v && a.indexOf(v) === i && !years.has(v) && !loading.has(v));
  if (!want.length) return;
  want.forEach((v) => loading.add(v));
  Promise.all(want.map(loadYear)).then(() => {
    want.forEach((v) => loading.delete(v));
    onReady?.();
  });
}

// Holidays on one day, from the years already loaded.
export function holidaysOn(t) {
  const d0 = startOfDay(t);
  return (years.get(new Date(d0).getFullYear()) || []).filter((h) => h.at === d0);
}

// The next holiday within a month, for the line under the date.
export function nextHoliday(t = Date.now()) {
  const d0 = startOfDay(t);
  const y = new Date(d0).getFullYear();
  const all = [...(years.get(y) || []), ...(years.get(y + 1) || [])];
  return all.find((h) => h.at >= d0 && h.at < addDays(d0, 31)) || null;
}

export function renderHoliday() {
  const el = $('#holiday-line');
  if (!el) return;
  const h = nextHoliday();
  el.hidden = !h;
  if (!h) return;
  const days = Math.round((h.at - startOfDay()) / 86400000);
  el.textContent = days === 0 ? (h.clock ? `${h.name} today` : `Today is ${h.name}`) : days === 1 ? `${h.name} tomorrow` : `${h.name} in ${days} days`;
}

// Calendar names a holiday too ("Halloween", "Thanksgiving Day"): don't say it twice.
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/day$/, '');
export const coveredBy = (holiday, titles) => titles.some((t) => {
  const a = norm(holiday.name);
  const b = norm(t);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 5 && short.length >= long.length * 0.6 && long.includes(short);
});
