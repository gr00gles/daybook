// The ticker: one bar under the top band where any card can show its latest, the cards taking
// turns. Each card hands over its items with setTicker(card, items) whenever it draws; Settings →
// Cards and ticker says, for each, whether it shows on the page, in the ticker, both or neither. It
// crawls along on its own and stops while the pointer or focus is on it; the wheel, a trackpad
// or the arrow keys scroll it by hand. With reduced motion it only moves by hand.
//
// An item: { title, tag, meta, tone ('up', 'down' or 'now' for meta), href, newTab, event (a
// calendar event's key, which opens its details), color (a dot before the title), plain (no
// icon: a team's game) }. With more than one card in it, the others wear their card's icon.
import { $, esc, safeUrl } from './util.js';
import { icon } from './icons.js';

// Everything that can be on the page, in the ticker, both or neither, in Settings' order: its
// name, the Sections switch it goes with (on while any of its parts is shown somewhere), where it
// sits on the page (`board`: a card, or the top bar), what to hide when it's off the page, and the
// icon its items wear when they share the ticker. `modes` limits the choices: only cards can go
// in the flip card (flipcard.js), and the shortcut circles are hidden from the top bar for now
// (styles.css), so the sites can be in the ticker or off.
const TOP = ['card', 'both', 'ticker', 'off'];
export const TICKER_CARDS = {
  weather: { label: 'Weather', section: 'weather', board: 'Top bar', card: 'now-weather', icon: 'drop', modes: TOP },
  alerts: { label: 'Weather alerts', section: 'alerts', board: 'Top bar', card: 'nw-alert', icon: 'alert', modes: TOP },
  holidays: { label: 'Moon and holidays', section: 'sky', board: 'Top bar', card: 'moon', icon: 'heart', modes: TOP },
  shortcuts: { label: 'Most visited sites', section: 'shortcuts', board: 'Top bar', card: 'shortcuts', icon: 'link', modes: ['ticker', 'off'] },
  today: { label: 'Today', section: 'calendar', board: 'Card', card: 'card-today', icon: 'clock' },
  month: { label: 'Month', section: 'calendar', board: 'Card', card: 'card-month', icon: 'clock' },
  mail: { label: 'Unread mail', section: 'mail', board: 'Card', card: 'card-mail', icon: 'mail' },
  deliveries: { label: 'Deliveries', section: 'packages', board: 'Card', card: 'card-deliveries', icon: 'box' },
  news: { label: 'Headlines', section: 'news', board: 'Card', card: 'card-news', icon: 'globe' },
  notes: { label: 'Notes', section: 'notes', board: 'Card', card: 'card-notes', icon: 'edit' },
  stocks: { label: 'Markets', section: 'stocks', board: 'Card', card: 'card-stocks', icon: 'money' },
  teams: { label: 'Teams', section: 'teams', board: 'Card', card: 'card-teams', icon: 'star' },
  area: { label: 'Around you', section: 'area', board: 'Card', card: 'card-area', icon: 'pin' },
  jobs: { label: 'NYS jobs', section: 'jobs', board: 'Card', card: 'card-jobs', icon: 'building' },
  youtube: { label: 'YouTube', section: 'youtube', board: 'Card', card: 'card-youtube', icon: 'video' },
};
export const TICKER_MODES = { card: 'Card', both: 'Card and ticker', ticker: 'Ticker only', flip: 'Flip card', off: 'Off' };

const PER_CARD = 10;
const MAX = 60;
const SPEED = 42; // pixels a second
const FADE = 18; // how far in from each end of the strip items have faded in: the cards' corner radius (--radius in styles.css)

let settings = null;
const sources = new Map(); // card -> its items
let paintTimer;
let painted = '';
let pos = 0; // where the strip is scrolled to, kept in fractions of a pixel
let held = false;

export const tickerModes = (key) => TICKER_CARDS[key].modes || Object.keys(TICKER_MODES);
export function tickerMode(S, key) {
  const ok = tickerModes(key);
  return ok.includes(S.ticker?.[key]) ? S.ticker[key] : ok.includes('card') ? 'card' : 'off';
}
// A card is in the ticker when it's set to the ticker and its section is on...
export const onTicker = (S, key) => ['both', 'ticker'].includes(tickerMode(S, key)) && S.show[TICKER_CARDS[key].section] !== false;
// ...and off the board when it's in the ticker only, or off altogether.
export const offBoard = (S, key) => ['ticker', 'off'].includes(tickerMode(S, key)) || S.show[TICKER_CARDS[key].section] === false;

// A section is on while any of its parts shows somewhere. Turning a section off under the old
// Sections switches turns all of its parts off.
export function settleSections(S) {
  for (const sec of new Set(Object.values(TICKER_CARDS).map((c) => c.section))) {
    const keys = Object.keys(TICKER_CARDS).filter((k) => TICKER_CARDS[k].section === sec);
    if (S.show[sec] === false) for (const k of keys) S.ticker[k] = 'off';
    else S.show[sec] = keys.some((k) => tickerMode(S, k) !== 'off');
  }
}
const shared = (S) => Object.keys(TICKER_CARDS).filter((k) => onTicker(S, k));

export function setTicker(key, items) {
  sources.set(key, items || []);
  clearTimeout(paintTimer);
  paintTimer = setTimeout(paint, 150);
}

// The cards take turns, a few items from each, until the bar is full.
function list() {
  const keys = shared(settings);
  const lists = keys.map((k) => (sources.get(k) || []).slice(0, PER_CARD).map((n) => ({ ...n, from: k })));
  const out = [];
  for (let i = 0; out.length < MAX && lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out.slice(0, MAX);
}

function itemHtml(n, copy, mixed) {
  const tab = copy ? ' tabindex="-1"' : '';
  const inner = `${mixed && !n.plain ? `<span class="tkr-from" title="${esc(TICKER_CARDS[n.from].label)}">${icon(TICKER_CARDS[n.from].icon)}</span>` : ''}${
    n.tag ? `<span class="tkr-tag">${esc(n.tag)}</span>` : ''
  }${n.color ? `<span class="tkr-dot" style="--c: ${n.color}"></span>` : ''
  }<span class="tkr-title">${esc(n.title)}</span>${n.meta ? `<span class="tkr-meta${n.tone ? ` ${n.tone}` : ''}">${esc(n.meta)}</span>` : ''}`;
  if (n.event) return `<button type="button" class="tkr-item" data-event="${esc(n.event)}"${tab}>${inner}</button>`;
  if (n.href) return `<a class="tkr-item" href="${esc(safeUrl(n.href))}"${n.newTab ? ' target="_blank" rel="noopener"' : ''}${tab}>${inner}</a>`;
  return `<span class="tkr-item">${inner}</span>`;
}

function paint() {
  if (!settings) return;
  const keys = shared(settings);
  const items = list();
  const strip = $('#ticker-strip');
  // Two copies, so the strip can wrap around without a gap; the second is out of the tab order.
  const run = (copy) => items.map((n) => itemHtml(n, copy, keys.length > 1)).join('');
  const html = items.length
    ? `<div class="tkr-run">${run(false)}</div><div class="tkr-run" aria-hidden="true">${run(true)}</div>`
    : `<span class="tkr-quiet">${sources.size ? 'Nothing new right now.' : 'Loading…'}</span>`;
  if (html === painted) return;
  painted = html;
  strip.innerHTML = html;
  // Carry on from about where it was, rather than jumping back to the start.
  const half = strip.firstElementChild?.offsetWidth || 0;
  pos = half ? pos % half : 0;
  strip.scrollLeft = pos;
}

export function initTicker(S) {
  settings = S;
  const box = $('#ticker');
  box.hidden = !shared(S).length;
  if (box.hidden) return;
  const strip = $('#ticker-strip');
  const hold = (on) => () => (held = on || box.matches(':hover, :focus-within'));
  box.addEventListener('pointerenter', hold(true));
  box.addEventListener('pointerleave', hold(false));
  box.addEventListener('focusin', hold(true));
  box.addEventListener('focusout', () => setTimeout(hold(false)));
  // A wheel that turns up and down scrolls the strip sideways.
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  // Scrolled by hand: carry on from there, wrapping round past the first copy.
  strip.addEventListener('scroll', () => {
    const half = strip.firstElementChild?.offsetWidth || 0;
    if (half && strip.scrollLeft >= half) strip.scrollLeft -= half;
    if (Math.abs(strip.scrollLeft - pos) > 2) pos = strip.scrollLeft;
  });
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let last = 0;
  const step = (t) => {
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    // Items that all fit hold still, once, clear of the fade at the start.
    const half = strip.firstElementChild?.offsetWidth || 0;
    const fits = half + 2 * FADE <= strip.clientWidth;
    if (strip.classList.contains('fits') !== fits) {
      strip.classList.toggle('fits', fits);
      pos = 0;
      strip.scrollLeft = 0;
    }
    if (!held && !still.matches && !fits) {
      pos += SPEED * dt;
      if (pos >= half) pos -= half;
      strip.scrollLeft = pos;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  paint();
}
