// The moon's phase and the next holidays, worked out on this computer. US holidays are
// computed; other countries' public holidays come from Nager.Date (no key). Settings picks
// which holidays show, and each has its own look (Halloween orange with a pumpkin, say).
import { $, esc, local, startOfDay, addDays } from './util.js';
import { setTicker } from './ticker.js';

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
  moonItem = { tag: 'Moon', title: m.name, meta: `${pct}% lit${next ? ` · ${next}` : ''}` };
  skyTicker();
}

// In the ticker: the moon, then the holidays of the next two months.
let moonItem = null;
let onPage = true;
export const setSkyOnPage = (on) => (onPage = on);

function skyTicker() {
  const d0 = startOfDay();
  const y = new Date(d0).getFullYear();
  const soon = [...(years.get(y) || []), ...(years.get(y + 1) || [])].filter((h) => h.at >= d0 && h.at < addDays(d0, 62) && picked(h));
  const when = (t) => (t === d0 ? 'Today' : dayName(t).replace(/^t/, 'T'));
  setTicker('holidays', [...(moonItem ? [moonItem] : []), ...soon.slice(0, 8).map((h) => ({ tag: when(h.at), title: `${holidayTheme(h).glyph} ${h.name}` }))]);
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

// The ones marked false start out hidden; Settings → Holidays turns them on.
function usHolidays(y) {
  const d = (m, day) => new Date(y, m, day).getTime();
  return [
    ['newyear', d(0, 1), "New Year's Day"],
    ['mlk', nth(y, 0, 1, 3), 'Martin Luther King Jr. Day'],
    ['superbowl', nth(y, 1, 0, 2), 'Super Bowl Sunday', false],
    ['valentines', d(1, 14), "Valentine's Day"],
    ['presidents', nth(y, 1, 1, 3), "Presidents' Day"],
    ['stpatricks', d(2, 17), "St. Patrick's Day"],
    ['easter', easter(y), 'Easter'],
    ['earthday', d(3, 22), 'Earth Day', false],
    ['cincodemayo', d(4, 5), 'Cinco de Mayo', false],
    ['mothers', nth(y, 4, 0, 2), "Mother's Day"],
    ['memorial', nth(y, 4, 1, -1), 'Memorial Day'],
    ['fathers', nth(y, 5, 0, 3), "Father's Day"],
    ['juneteenth', d(5, 19), 'Juneteenth'],
    ['independence', d(6, 4), 'Independence Day'],
    ['labor', nth(y, 8, 1, 1), 'Labor Day'],
    ['columbus', nth(y, 9, 1, 2), 'Columbus Day'],
    ['halloween', d(9, 31), 'Halloween'],
    // The Tuesday after the first Monday in November.
    ['election', addDays(nth(y, 10, 1, 1), 1), 'Election Day', false],
    ['veterans', d(10, 11), 'Veterans Day'],
    ['thanksgiving', nth(y, 10, 4, 4), 'Thanksgiving'],
    ['blackfriday', addDays(nth(y, 10, 4, 4), 1), 'Black Friday', false],
    ['christmaseve', d(11, 24), 'Christmas Eve'],
    ['christmas', d(11, 25), 'Christmas'],
    ['newyearseve', d(11, 31), "New Year's Eve"],
  ].map(([key, at, name, on = true]) => ({ key, at, name, on }));
}

// Days the clocks change in this computer's time zone. Offsets are compared at noon, since
// some places change at midnight and that midnight doesn't exist.
function clockChanges(y) {
  const out = [];
  let prev = new Date(y - 1, 11, 31, 12).getTimezoneOffset();
  for (let d = new Date(y, 0, 1, 12); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
    const off = d.getTimezoneOffset();
    if (off !== prev) {
      const mins = Math.abs(off - prev);
      const amount = mins === 60 ? 'an hour' : mins === 30 ? 'half an hour' : `${mins} minutes`;
      out.push({ key: 'clocks', at: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), name: `Clocks go ${off > prev ? 'back' : 'forward'} ${amount}`, clock: true, on: true });
    }
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
  // v2 keeps a key and look for each.
  const key = `holidays2:${country}:${y}`;
  const stored = await local.get(key);
  if (stored && Date.now() - stored.at < 30 * 86400e3) return stored.list;
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/${country}`);
    // 204/404 (or 400 for an odd code): Nager.Date doesn't cover this country. Anything else
    // is a hiccup, and the stored list (if any) stands.
    if (!res.ok && ![400, 404].includes(res.status)) throw new Error(`HTTP ${res.status}`);
    const raw = res.ok && res.status !== 204 ? await res.json() : [];
    const list = raw
      .filter((h) => h.global !== false && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
      .map((h) => {
        const [yy, mm, dd] = h.date.split('-').map(Number);
        const name = String(h.localName || h.name).slice(0, 60);
        // Keyed by the English name, which stays the same from year to year.
        return { key: `p:${norm(String(h.name || name))}`, at: new Date(yy, mm - 1, dd).getTime(), name, en: String(h.name || ''), on: true };
      });
    await local.set(key, { at: Date.now(), list });
    return list;
  } catch {
    return stored?.list || [];
  }
}

const years = new Map(); // year -> list
const loading = new Map(); // year -> promise

function loadYear(y) {
  if (!loading.has(y))
    loading.set(
      y,
      (async () => {
        const country = region();
        const list = [...(country === 'US' ? usHolidays(y) : await publicHolidays(country, y)), ...clockChanges(y)];
        years.set(y, list.sort((a, b) => a.at - b.at));
      })(),
    );
  return loading.get(y);
}

// Loads this year and next (and any years the month view flips to), then calls back once
// they are all in, unless they already were.
export function loadHolidays(onReady, ...extraYears) {
  const y = new Date().getFullYear();
  const want = [y, y + 1, ...extraYears].filter((v, i, a) => v && a.indexOf(v) === i);
  if (want.every((v) => years.has(v))) return;
  Promise.all(want.map(loadYear)).then(() => onReady?.());
}

// Which holidays show: Settings keeps only the ones you changed, by key.
let choices = {};
export function setHolidayChoices(c) {
  choices = c && typeof c === 'object' ? c : {};
}
const picked = (h) => choices[h.key] ?? h.on !== false;

// Holidays on one day, from the years already loaded.
export function holidaysOn(t) {
  const d0 = startOfDay(t);
  return (years.get(new Date(d0).getFullYear()) || []).filter((h) => h.at === d0 && picked(h));
}

// The next holiday within a month, for the line under the date.
export function nextHoliday(t = Date.now()) {
  const d0 = startOfDay(t);
  const y = new Date(d0).getFullYear();
  const all = [...(years.get(y) || []), ...(years.get(y + 1) || [])];
  return all.find((h) => h.at >= d0 && h.at < addDays(d0, 31) && picked(h)) || null;
}

// Every holiday there is to pick from, in this year's order, for Settings.
export async function holidayChoices() {
  const y = new Date().getFullYear();
  await loadYear(y);
  const seen = new Set();
  return (years.get(y) || [])
    .filter((h) => !seen.has(h.key) && seen.add(h.key))
    .map((h) => ({ key: h.key, name: h.clock ? 'Clock changes' : h.name, at: h.at, on: h.on !== false, theme: holidayTheme(h) }));
}

// ---- How each holiday looks ----------------------------------------------------------------

const THEMES = {
  newyear: { color: '#c99a06', glyph: '🎉' },
  mlk: { color: '#5b6fd6', glyph: '🕊️' },
  superbowl: { color: '#3f7d34', glyph: '🏈' },
  valentines: { color: '#e0457b', glyph: '💘' },
  presidents: { color: '#3d5fc4', glyph: '🏛️' },
  stpatricks: { color: '#1f9d55', glyph: '☘️' },
  easter: { color: '#9b6fd6', glyph: '🐣' },
  earthday: { color: '#2e9d5b', glyph: '🌎' },
  cincodemayo: { color: '#de5a12', glyph: '🌮' },
  mothers: { color: '#d6549a', glyph: '💐' },
  memorial: { color: '#3d5a99', glyph: '🎖️' },
  fathers: { color: '#2f6fb3', glyph: '👔' },
  juneteenth: { color: '#c0392b', glyph: '✊🏾' },
  independence: { color: '#d03b3b', glyph: '🎆' },
  labor: { color: '#4f7392', glyph: '🛠️' },
  columbus: { color: '#13839a', glyph: '⛵' },
  halloween: { color: '#f07a18', glyph: '🎃' },
  election: { color: '#3d5fc4', glyph: '🗳️' },
  veterans: { color: '#667a2e', glyph: '🎖️' },
  thanksgiving: { color: '#b8621b', glyph: '🦃' },
  blackfriday: { color: '#6b6f78', glyph: '🛍️' },
  christmaseve: { color: '#1f8a52', glyph: '🕯️' },
  christmas: { color: '#d62f2f', glyph: '🎄', hat: true },
  newyearseve: { color: '#8a6dd9', glyph: '🥂' },
  clocks: { color: '#7a8794', glyph: '⏰' },
  other: { color: '#c2410c', glyph: '✨' },
};

// Other countries' holidays get the look of the one they match, by their English name.
const LIKE = [
  [/christmas eve/i, 'christmaseve'],
  [/christmas|boxing|st\.? stephen/i, 'christmas'],
  [/new year'?s eve/i, 'newyearseve'],
  [/new year/i, 'newyear'],
  [/easter|good friday|whit|pentecost|ascension/i, 'easter'],
  [/halloween/i, 'halloween'],
  [/valentine/i, 'valentines'],
  [/patrick/i, 'stpatricks'],
  [/mother/i, 'mothers'],
  [/father/i, 'fathers'],
  [/thanksgiving/i, 'thanksgiving'],
  [/labou?r|workers|may day/i, 'labor'],
  [/remembrance|memorial|anzac|veteran|armistice/i, 'memorial'],
  [/independence|national|republic|constitution|liberation|canada day|australia day/i, 'independence'],
];

export function holidayTheme(h) {
  if (h.clock) return { id: 'clocks', ...THEMES.clocks };
  if (THEMES[h.key]) return { id: h.key, ...THEMES[h.key] };
  const id = LIKE.find(([re]) => re.test(h.en || h.name))?.[1] || 'other';
  return { id, ...THEMES[id] };
}

// A Santa hat for the corner of Christmas's badge.
const HAT = `<svg class="hol-hat" viewBox="0 0 32 26" aria-hidden="true"><path d="M4 19C6 9 13 3 21 4c4 .6 6 4 6.6 8.4L24 14C22 10 19 9.6 16.5 11 13 13 11 16 10.5 19z" fill="#e03131" stroke="#8e1b1b" stroke-width="1.2" stroke-linejoin="round"/><rect x="2" y="17.5" width="16" height="6" rx="3" fill="#fff" stroke="#e3e3e3"/><circle cx="26.5" cy="16" r="3.4" fill="#fff" stroke="#e3e3e3"/></svg>`;

// A holiday as a small colored badge with its emblem; `text` says it (defaults to its name).
export function holidayBadge(h, { text = h.name, today = false, tag = 'span' } = {}) {
  const t = holidayTheme(h);
  return `<${tag} class="hol-badge hol-${t.id}${today ? ' today' : ''}" style="--hol: ${t.color}">${t.hat ? HAT : ''}<span class="hol-glyph" aria-hidden="true">${t.glyph}</span><span class="hol-name">${esc(text)}</span></${tag}>`;
}

export function renderHoliday() {
  const el = $('#holiday-line');
  if (!el) return;
  skyTicker();
  const h = onPage ? nextHoliday() : null;
  el.hidden = !h;
  if (!h) return;
  const days = Math.round((h.at - startOfDay()) / 86400000);
  const text = days === 0 ? (h.clock ? `${h.name} today` : `Today is ${h.name}`) : days === 1 ? `${h.name} tomorrow` : `${h.name} in ${days} days`;
  el.innerHTML = holidayBadge(h, { text, today: days === 0 });
}

// Calendar names a holiday too ("Halloween", "Thanksgiving Day"): don't say it twice.
const norm = (s) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/day$/, '');
const CLOCK_EVENT = /daylight sav|summer ?time|winter ?time|standard time|clocks? (?:go|change|spring|fall)|\bdst\b/i;
export const coveredBy = (holiday, titles) => titles.some((t) => {
  if (holiday.clock) return CLOCK_EVENT.test(t);
  const a = norm(holiday.name);
  const b = norm(t);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  // Five letters, or two characters in scripts that write a word in one or two.
  const enough = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d]+$/u.test(short) ? 5 : 2;
  return [...short].length >= enough && short.length >= long.length * 0.6 && long.includes(short);
});
