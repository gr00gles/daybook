export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const local = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (keys) => chrome.storage.local.remove(keys),
};

export function hash(value) {
  const s = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const inflight = new Map(); // key|sig -> { job, n }
let calls = 0;

// Cache-first loader shared by every card: paint the stored copy at once, then refetch
// when it is older than maxAge (or when forced). `sig` names the settings the data was
// fetched with, so changing a setting makes the stored copy a miss.
export async function cached({ key, sig = '', maxAge, force = false, fetch: fetcher, render }) {
  const n = ++calls;
  const stored = await local.get('cache:' + key);
  let hit = stored && stored.sig === sig ? stored : null;
  if (hit) render(hit.data, { at: hit.at });
  if (hit && !force && Date.now() - hit.at < maxAge) return;
  // One fetch at a time per key and settings. A forced refresh (after a change you made) waits
  // for one already running, which may have started before the change, and then fetches again,
  // unless another fetch began after this call did (that one sees the change too).
  const flight = `${key}|${sig}`;
  if (inflight.has(flight)) {
    if (!force) return inflight.get(flight).job;
    await inflight.get(flight).job;
    const now = inflight.get(flight);
    if (now && now.n > n) return now.job;
    const fresh = await local.get('cache:' + key);
    hit = fresh && fresh.sig === sig ? fresh : null;
  }
  const job = (async () => {
    try {
      const data = await fetcher();
      const at = Date.now();
      await local.set('cache:' + key, { sig, at, data });
      render(data, { at, fresh: true });
    } catch (error) {
      console.warn(`[daybook] ${key}:`, error);
      render(hit?.data ?? null, { at: hit?.at, error });
    }
  })().finally(() => inflight.get(flight)?.job === job && inflight.delete(flight));
  inflight.set(flight, { job, n });
  return job;
}

export async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

export const startOfDay = (t = Date.now()) => new Date(t).setHours(0, 0, 0, 0);
export const addDays = (t, n) => {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

export const fmtTime = (ms, h24 = false) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !h24 });

export const fmtHour = (ms, h24 = false) =>
  h24
    ? String(new Date(ms).getHours()).padStart(2, '0')
    : new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' AM', 'a').replace(' PM', 'p');

export function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 6 * 86400) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function untilText(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export function updatedText(at) {
  if (!at) return '';
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) return 'updated just now';
  if (m < 60) return `updated ${m}m ago`;
  return `updated ${Math.floor(m / 60)}h ago`;
}

export function errorText(err) {
  if (err instanceof TypeError && /fetch/i.test(err.message)) return "couldn't connect. Check your internet connection";
  return err?.message || String(err || 'Unknown error');
}

// Calendar colors are either one of the page's palette slots (1-8) or a hex color from Google.
export const colorVar = (c) => (typeof c === 'number' ? `var(--cat-${c})` : /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : 'var(--cat-1)');

// Only ordinary web links go into href attributes; feeds and calendars are outside data.
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '#');

// Shows or hides an element with the "pop" class (styles.css, Motion), letting it animate
// out before it gets the hidden attribute.
const leaving = new WeakMap();
export function showPop(el, show) {
  if (!el) return;
  clearTimeout(leaving.get(el));
  leaving.delete(el);
  el.classList.remove('leaving');
  if (show || el.hidden) {
    el.hidden = !show;
    return;
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.hidden = true;
    return;
  }
  el.classList.add('leaving');
  const ms = parseFloat(getComputedStyle(el).getPropertyValue('--pop-out')) * 1000 || 160;
  leaving.set(
    el,
    setTimeout(() => {
      el.hidden = true;
      el.classList.remove('leaving');
      leaving.delete(el);
    }, ms),
  );
}

// A short message at the bottom of the page, optionally with an Undo button.
let toastTimer;
export function showToast(message, undo) {
  const el = document.querySelector('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button class="btn small" type="button">Undo</button>' : ''}`;
  showPop(el, true);
  const hide = () => showPop(el, false);
  el.querySelector('button')?.addEventListener('click', () => {
    hide();
    undo();
  });
  toastTimer = setTimeout(hide, undo ? 7000 : 5000);
}
