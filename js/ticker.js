// The ticker: one bar under the top band where any card can show its latest, the cards taking
// turns. Each card hands over its items with setTicker(card, items) whenever it draws; Settings →
// Ticker says which cards are in it, and whether each card still shows on the board too. It
// crawls along on its own and stops while the pointer or focus is on it; the wheel, a trackpad
// or the arrow keys scroll it by hand. With reduced motion it only moves by hand.
//
// An item: { title, tag, meta, tone ('up', 'down' or 'now' for meta), href, newTab, event (a
// calendar event's key, which opens its details), color (a dot before the title), pair: { us,
// them, sep } (two logos, like a game's) }.
import { $, esc, safeUrl } from './util.js';
import { icon } from './icons.js';

// Every card that can be in the ticker, in Settings' order: its name, the Sections switch it
// goes with, its card on the board, and the icon its items wear when cards share the ticker.
export const TICKER_CARDS = {
  today: { label: 'Today', section: 'calendar', card: 'card-today', icon: 'clock' },
  month: { label: 'Month', section: 'calendar', card: 'card-month', icon: 'clock' },
  notes: { label: 'Notes', section: 'notes', card: 'card-notes', icon: 'edit' },
  stocks: { label: 'Markets', section: 'stocks', card: 'card-stocks', icon: 'money' },
  teams: { label: 'Teams', section: 'teams', card: 'card-teams', icon: 'star' },
  news: { label: 'Headlines', section: 'news', card: 'card-news', icon: 'globe' },
  jobs: { label: 'NYS jobs', section: 'jobs', card: 'card-jobs', icon: 'building' },
  deliveries: { label: 'Deliveries', section: 'packages', card: 'card-deliveries', icon: 'box' },
  mail: { label: 'Unread', section: 'mail', card: 'card-mail', icon: 'mail' },
  area: { label: 'Around you', section: 'area', card: 'card-area', icon: 'pin' },
  youtube: { label: 'YouTube', section: 'youtube', card: 'card-youtube', icon: 'video' },
};
export const TICKER_MODES = { card: 'Card', both: 'Card and ticker', ticker: 'Ticker only' };

const PER_CARD = 10;
const MAX = 60;
const SPEED = 42; // pixels a second
const FADE = 124; // how far in from the strip's start items have faded in (styles.css)

let settings = null;
const sources = new Map(); // card -> its items
let paintTimer;
let painted = '';
let pos = 0; // where the strip is scrolled to, kept in fractions of a pixel
let held = false;

export const tickerMode = (S, key) => (TICKER_MODES[S.ticker?.[key]] ? S.ticker[key] : 'card');
// A card is in the ticker when it's switched on under Sections and set to the ticker.
export const onTicker = (S, key) => tickerMode(S, key) !== 'card' && S.show[TICKER_CARDS[key].section] !== false;
// ...and off the board when it's in the ticker only.
export const offBoard = (S, key) => tickerMode(S, key) === 'ticker';
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
  const logo = (src) => `<img src="${esc(safeUrl(src))}" alt="" width="18" height="18" loading="lazy">`;
  const inner = `${mixed ? `<span class="tkr-from" title="${esc(TICKER_CARDS[n.from].label)}">${icon(TICKER_CARDS[n.from].icon)}</span>` : ''}${
    n.tag ? `<span class="tkr-tag">${esc(n.tag)}</span>` : ''
  }${n.pair?.us && n.pair.them ? `<span class="tkr-pair">${logo(n.pair.us)}<span>${esc(n.pair.sep || 'vs')}</span>${logo(n.pair.them)}</span>` : ''}${
    n.color ? `<span class="tkr-dot" style="--c: ${n.color}"></span>` : ''
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
  $('#ticker-label').textContent = keys.length === 1 ? TICKER_CARDS[keys[0]].label : 'At a glance';
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
    const fits = half + FADE <= strip.clientWidth;
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
