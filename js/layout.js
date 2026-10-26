// Arrange mode: drag cards between and within the board's columns, drag a card's bottom
// edge to set its height, drag the lines between columns to change their widths, switch
// the board between three columns and four, and turn fitting the window on or off.
// The layout is saved under its own key in chrome.storage.sync, apart from Settings:
//   { v: 1, rev: 6, count: 3 | 4, fit: false, cols: { day: [card ids], mail: [...], out: [...] },
//     cols4: { day, mail, out, more }, widths: [fr × 3], widths4: [fr × 4], heights: { id: px } }
// Three and four columns each keep their own arrangement and widths; heights are shared. With
// no count saved, windows at least AUTO_FOUR wide get four, arranged as FOUR. Layouts saved
// before rev 6 keep only their count: the cards moved to the default board.
// Cards are a fixed size: their height comes from the layout, never from what's in them, so
// they stay put as they refresh. While the columns sit side by side, each column fills the
// window and its cards split it by SHARE (see split); otherwise each card is its SHARE times
// UNIT tall. A height set by dragging overrides either. A card with more than fits drops whole
// items (emails, games, events, list rows) from the end, never a scroll bar. The exception:
// Unread and Teams, and NYS jobs and Today, in one column share their room by how much mail or
// how many postings there are (see LEAN).
// Cards a saved layout doesn't name (a card added in a later version) keep their default spot.
import { $, $$, esc, showPop, zoom, rectOf } from './util.js';
import { icon } from './icons.js';
import { loadSettings, saveSettings, defaultBoard } from './settings.js';

const KEY = 'layout';
const REV = 6;
const DEFAULT_WIDTHS = { 3: [1.1, 1.2, 1], 4: [1, 1.3, 1, 0.9] };
// Three columns are as in newtab.html: Today and NYS jobs, the month and Markets, Unread, the
// flip card, Deliveries and Teams. Four give the flip card and Deliveries a column of their own.
const FOUR = {
  day: ['card-today', 'card-jobs', 'card-notes'],
  mail: ['card-month', 'card-stocks'],
  out: ['card-mail', 'card-teams', 'card-area'],
  more: ['card-flip', 'card-deliveries', 'card-news', 'card-youtube'],
};
const AUTO_FOUR = 1480;
const MIN_WIDTH = 0.5;
const MIN_HEIGHT = 140;
// How much of its column each card takes; the rest take 2.
const SHARE = { 'card-today': 3, 'card-month': 3, 'card-mail': 3, 'card-flip': 3, 'card-news': 3, 'card-youtube': 3 };
// The least a card gets when the column is short: the month needs its weeks.
const FLOOR = { 'card-month': 320 };
// Cards that keep at least this many items however short the column, taking the room from the
// cards beside them. The month keeps every event its days show (up to three a day), and Markets
// its four rows, tight (see needed).
const KEEP = { 'card-jobs': 2, 'card-deliveries': 4, 'card-teams': 2 };
// Pairs of cards that share the room the split gives the two of them when they're in one
// column: the first takes what it needs to show everything (no more, even under MIN_HEIGHT),
// the second the rest, neither cut below its floor. Teams grows as the mail goes down, taking
// all but one line when there's none.
// With `cap`, the first takes no more than the split gave it: NYS jobs gives Today the room its
// postings don't need, but never takes any of Today's.
const LEAN = [
  ['card-mail', 'card-teams'],
  ['card-jobs', 'card-today', { cap: true }],
];
const UNIT = 150; // pixels a share is worth when the cards don't fit the window
const FIT_BOTTOM = 6; // room kept under the cards (the board's bottom padding), plus the credits line (#credits)
const TUCK_GAP = 4; // least room kept above and below the ticker
const TICKER_H = [24, 40]; // the ticker's least and greatest height
// The band's lines of text, measured to their baseline: a line's box runs on below its letters.
const TEXT_IN_BAND = '.clock, .greeting, .date-line, .nw-cond, .nw-meta, .nw-place, .nh-temp, .nh-pop:not(:empty)';
// What else the band draws, measured to its edge.
const DRAWN_IN_BAND = '.search-box, .shortcuts, .nw-alert, .nw-hours .wx-icon, #now-weather > .notice, #now-weather > .btn';

let layout = { v: 1, rev: REV, count: null, fit: true, cols: {}, cols4: null, widths: null, widths4: null, heights: {} };
let arranging = false;
let count = 3; // columns on the board now
let defaults = null; // where each card sits in newtab.html

const board = () => $('.board');
const allColumns = () => $$('.board > .col');
const columns = () => allColumns().filter((col) => !col.hidden);
const colKey = (col) => [...col.classList].find((c) => c.startsWith('col-'))?.slice(4);
const cardsIn = (col) => [...col.children].filter((el) => el.matches('.card[id]'));
// The cards on the board themselves: not the ones taking turns inside the flip card.
const BOARD_CARDS = '.board .card[id]:not(.flip-face)';
const shown = (card) => !card.hidden && card.offsetParent !== null;
// True while the board shows every column side by side: the lines between them can be
// dragged, and the columns fit the window.
const allAcross = () => {
  const cols = columns().map(rectOf);
  return cols.length === count && cols.every((r, i) => i === 0 || (Math.abs(r.top - cols[0].top) < 2 && cols[i - 1].right < r.left));
};
const widthsKey = () => (count === 4 ? 'widths4' : 'widths');
const wantedCount = () => layout.count || (innerWidth / zoom() >= AUTO_FOUR ? 4 : 3);

async function save() {
  layout[count === 4 ? 'cols4' : 'cols'] = Object.fromEntries(columns().map((col) => [colKey(col), cardsIn(col).map((c) => c.id)]));
  await chrome.storage.sync.set({ [KEY]: layout });
}

function applyWidths() {
  const w = layout[widthsKey()];
  board().style.setProperty('--board-cols', w ? w.map((f) => `minmax(0, ${f}fr)`).join(' ') : null);
  if (!w) board().style.removeProperty('--board-cols');
}

// Puts every card in its column for `n` columns: its spot in newtab.html, then the saved
// arrangement on top, so cards it doesn't name stay where they start.
function place(n) {
  const byKey = Object.fromEntries(allColumns().map((col) => [colKey(col), col]));
  const put = (cols) => {
    for (const [key, ids] of Object.entries(cols || {})) {
      const col = byKey[key];
      if (!col || (key === 'more' && n !== 4) || !Array.isArray(ids)) continue;
      for (const id of ids) {
        const card = document.getElementById(id);
        if (card?.matches(BOARD_CARDS)) col.append(card);
      }
    }
  };
  put(defaults);
  if (n === 4) put(FOUR);
  put(n === 4 ? layout.cols4 : layout.cols);
  count = n;
  byKey.more.hidden = n !== 4;
  board().dataset.cols = String(n);
  applyWidths();
  scheduleFit();
}

// The items a card can drop: entries of its lists, outermost only, in page order.
const itemsOf = (card) =>
  [...card.querySelectorAll(':scope > :not(.card-head, .card-foot) :is(ol, ul) > li')].filter((li) => !li.parentElement.closest('li, .flip-off'));

// Shows only the first k items.
function showFirst(items, k) {
  items.forEach((li, i) => li.toggleAttribute('data-clip', i >= k));
}

// Shows as many whole items as fit in h pixels (all of them without h).
function fitItems(card, h) {
  const items = itemsOf(card);
  showFirst(items, items.length);
  if (!h || card.offsetHeight <= h || items.length < 2) return;
  // The most items that fit, at least one: a binary search keeps it to a few layouts.
  let lo = 1;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    showFirst(items, mid);
    if (card.offsetHeight <= h) lo = mid;
    else hi = mid - 1;
  }
  showFirst(items, lo);
}

// ---- Sizes ------------------------------------------------------------------------------

const share = (card) => SHARE[card.id] || 2;

// The height a card needs to show what it keeps, measured at its own height (see release): its
// first KEEP items, the whole month with every event its days show, or Markets' four rows at
// their tightest (styles.css spreads them out in a taller card).
function needed(card) {
  if (card.id === 'card-month' || card.id === 'card-stocks') return card.offsetHeight;
  const k = KEEP[card.id];
  if (!k) return 0;
  const items = itemsOf(card);
  showFirst(items, k);
  const h = card.offsetHeight;
  showFirst(items, items.length);
  return h;
}
const floorOf = (card) => Math.max(FLOOR[card.id] || MIN_HEIGHT, needed(card));

// Back to a card's own height, with every item, for measuring.
function release(card) {
  card.classList.remove('fixed');
  card.style.removeProperty('--card-h');
  showFirst(itemsOf(card), Infinity);
}

// Sets a card to h pixels, dropping the items that don't fit.
function fix(card, h) {
  h = Math.floor(h);
  fitItems(card, h);
  card.classList.add('fixed');
  card.style.setProperty('--card-h', `${h}px`);
}

// Splits `room` pixels between a column's cards: those with a height set by dragging keep it,
// and the others share the rest by SHARE, none below its floor (floors, by card). With every
// height set, the last card still takes what's left, so the column ends at the bottom. When the
// floors don't fit, the column runs past the bottom rather than cutting a card below MIN_HEIGHT.
function split(col, cards, room, floors) {
  const floor = (c) => floors.get(c);
  const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
  let free = room - gap * Math.max(0, cards.length - 1);
  const h = new Map();
  let flex = cards.filter((c) => !layout.heights[c.id]);
  if (!flex.length) flex = cards.slice(-1);
  for (const c of cards) {
    if (flex.includes(c)) continue;
    h.set(c, Math.max(MIN_HEIGHT, layout.heights[c.id]));
    free -= h.get(c);
  }
  const total = () => flex.reduce((sum, c) => sum + share(c), 0);
  for (let low; (low = flex.find((c) => (free * share(c)) / total() < floor(c))); ) {
    h.set(low, floor(low));
    free -= floor(low);
    flex = flex.filter((c) => c !== low);
  }
  for (const c of flex) h.set(c, Math.max(MIN_HEIGHT, (free * share(c)) / total()));
  return cards.map((c) => h.get(c));
}

// Shares out each LEAN pair's room in a column, for pairs with neither height set by dragging.
// Measured with the cards released.
function lean(cards, heights, floors) {
  for (const [first, second, { cap = false } = {}] of LEAN) {
    const [a, b] = [first, second].map((id) => cards.findIndex((c) => c.id === id));
    if (a < 0 || b < 0 || layout.heights[first] || layout.heights[second]) continue;
    const room = heights[a] + heights[b];
    // As short as what it holds, even under MIN_HEIGHT (an empty inbox is one line), but not
    // cut below its floor to make room.
    const own = cap ? Math.min(cards[a].offsetHeight, heights[a]) : cards[a].offsetHeight;
    const h = Math.min(own, room - floors.get(cards[b]));
    if (h < Math.min(own, floors.get(cards[a]))) continue; // no room for both floors: keep the split
    heights[a] = h;
    heights[b] = room - h;
  }
  return heights;
}

// The band is as tall as its tallest part, the stacked toolbar at the end, which leaves empty
// room between the clock, the search and the weather and the cards. The ticker floats there,
// out of the page's flow, so it never moves or shrinks the cards: as far from the band's lowest
// text as from the cards, as tall as fits up to TICKER_H. The toolbar runs down past the strip's
// faded end.
function baseline(el) {
  const probe = document.createElement('span');
  probe.style.cssText = 'display: inline-block; width: 0; height: 0; vertical-align: baseline;';
  el.append(probe);
  const y = rectOf(probe).top;
  probe.remove();
  return y;
}
function tuckTicker() {
  const bar = $('#ticker');
  if (!bar || bar.hidden) return;
  const shown = (e) => e.getClientRects().length > 0;
  const low = Math.max(
    ...$$(TEXT_IN_BAND).filter(shown).map(baseline),
    ...$$(DRAWN_IN_BAND).filter(shown).map((e) => rectOf(e).bottom),
  );
  const cards = rectOf(board()).top + parseFloat(getComputedStyle(board()).paddingTop);
  const h = Math.max(TICKER_H[0], Math.min(TICKER_H[1], Math.floor(cards - low - 2 * TUCK_GAP)));
  bar.style.setProperty('--tkr-h', `${h}px`);
  bar.style.top = `${Math.round(scrollY / zoom() + (low + cards - h) / 2)}px`;
}

function fitBoard() {
  const across = layout.fit !== false && allAcross();
  const bottom = innerHeight / zoom() - FIT_BOTTOM - ($('#credits')?.offsetHeight || 0);
  for (const col of columns()) {
    const cards = cardsIn(col).filter(shown);
    cardsIn(col).forEach(release);
    const top = rectOf(col).top + scrollY / zoom();
    const floors = new Map(cards.map((c) => [c, floorOf(c)]));
    const heights = lean(cards, across ? split(col, cards, bottom - top, floors) : cards.map((c) => layout.heights[c.id] || Math.max(share(c) * UNIT, floors.get(c))), floors);
    cards.forEach((card, i) => fix(card, heights[i]));
  }
}

// Cards re-render their lists on every refresh, and the window and the band above change
// size; fit again once per frame after any of it.
let fitting = 0;
export function scheduleFit() {
  if (!fitting) fitting = requestAnimationFrame(() => {
    fitting = 0;
    tuckTicker();
    fitBoard();
  });
}
function watchCards() {
  for (const card of $$(BOARD_CARDS))
    new MutationObserver(scheduleFit).observe(card, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  let width = board().offsetWidth;
  new ResizeObserver(() => {
    if (board().offsetWidth === width) return;
    width = board().offsetWidth;
    scheduleFit();
  }).observe(board());
  const sizes = new ResizeObserver(scheduleFit);
  // The weather can arrive without changing the band's height, but it moves the ticker.
  for (const el of $$('.sky, .when, .now-weather')) sizes.observe(el);
  new MutationObserver(scheduleFit).observe($('#ticker'), { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('resize', scheduleFit);
  document.fonts?.ready.then(scheduleFit);
}

// Runs before the cards render, so a saved layout doesn't jump into place.
export async function applyLayout() {
  try {
    const saved = (await chrome.storage.sync.get(KEY))[KEY];
    if (saved?.v === 1) layout.count = [3, 4].includes(saved.count) ? saved.count : null;
    if (saved?.v === 1 && saved.rev === REV)
      layout = {
        ...layout,
        fit: saved.fit !== false,
        cols: saved.cols || {},
        cols4: saved.cols4 || null,
        widths: saved.widths?.length === 3 ? saved.widths : null,
        widths4: saved.widths4?.length === 4 ? saved.widths4 : null,
        heights: saved.heights || {},
      };
  } catch {}
  defaults = Object.fromEntries(allColumns().map((col) => [colKey(col), cardsIn(col).map((c) => c.id)]));
  place(wantedCount());
  watchCards();
  // Without a saved count, the board follows the window across AUTO_FOUR.
  addEventListener('resize', () => {
    if (wantedCount() === count) return;
    place(wantedCount());
    paintBar();
    placeGutters();
  });
}

// ---- Moving ------------------------------------------------------------------------

// Follows the pointer on the window rather than with pointer capture: moving a card takes it
// out of the DOM for a moment, which would drop a capture held by its handle.
function follow(e, onMove, onEnd) {
  e.preventDefault();
  const id = e.pointerId;
  const move = (ev) => ev.pointerId === id && onMove(ev);
  const end = (ev) => {
    if (ev.pointerId !== id) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    onEnd();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

// Where a pointer at (x, y) would put a card: the column under it and the card to go before.
// In narrow windows columns stack in rows; the lowest one starting above the pointer wins.
function dropSpot(x, y, dragged) {
  const cols = columns().filter((c) => c.offsetParent !== null);
  const under = cols.filter((c) => {
    const r = rectOf(c);
    return x >= r.left && x <= r.right;
  });
  let col = under.filter((c) => rectOf(c).top <= y).at(-1) || under[0];
  if (!col) {
    col = cols.reduce((best, c) => {
      const r = rectOf(c);
      const d = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      return !best || d < best.d ? { c, d } : best;
    }, null)?.c;
  }
  if (!col) return null;
  const before = cardsIn(col).find((c) => {
    if (c === dragged || !shown(c)) return false;
    const r = rectOf(c);
    return y < r.top + r.height / 2;
  });
  return { col, before: before || null };
}

function moveTo(card, { col, before }) {
  if (before === card || (card.parentElement === col && card.nextElementSibling === before)) return false;
  col.insertBefore(card, before);
  return true;
}

function startMove(e, card) {
  card.classList.add('dragging');
  let moved = false;
  follow(
    e,
    (ev) => {
      const spot = dropSpot(ev.clientX / zoom(), ev.clientY / zoom(), card);
      if (spot && moveTo(card, spot)) moved = true;
    },
    () => {
      card.classList.remove('dragging');
      if (moved) save();
      scheduleFit();
      placeGutters();
    },
  );
}

// Arrow keys on a card's handle: up and down within its column, left and right across.
function keyMove(e, card) {
  const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  const side = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!step && !side) return;
  e.preventDefault();
  const col = card.parentElement;
  if (step) {
    const list = cardsIn(col).filter((c) => c === card || shown(c));
    const i = list.indexOf(card);
    const j = i + step;
    if (j < 0 || j >= list.length) return;
    col.insertBefore(card, step < 0 ? list[j] : list[j].nextElementSibling);
  } else {
    const cols = columns();
    const next = cols[cols.indexOf(col) + side];
    if (!next) return;
    next.append(card);
  }
  e.currentTarget.focus();
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  save();
  scheduleFit();
  placeGutters();
}

// ---- Heights -------------------------------------------------------------------------

function startResize(e, card) {
  const top = rectOf(card).top;
  follow(
    e,
    (ev) => {
      layout.heights[card.id] = Math.max(MIN_HEIGHT, Math.round(ev.clientY / zoom() - top));
      fitBoard();
    },
    () => {
      save();
      placeGutters();
    },
  );
}

function resetHeight(card) {
  delete layout.heights[card.id];
  fitBoard();
  save();
  placeGutters();
}

// ---- Column widths -------------------------------------------------------------------

function placeGutters() {
  const b = board();
  const gutters = $$('.col-gutter', b);
  if (!arranging || !allAcross()) {
    for (const g of gutters) g.hidden = true;
    return;
  }
  const br = rectOf(b);
  const cols = columns().map(rectOf);
  gutters.forEach((g, i) => {
    g.hidden = i >= cols.length - 1;
    if (!g.hidden) g.style.left = `${(cols[i].right + cols[i + 1].left) / 2 - br.left}px`;
  });
}

function startWiden(e, i) {
  const g = e.currentTarget;
  const rects = columns().map(rectOf);
  const total = (layout[widthsKey()] || DEFAULT_WIDTHS[count]).reduce((a, b) => a + b, 0);
  const span = rects.reduce((a, r) => a + r.width, 0);
  const start = e.clientX / zoom();
  const base = rects.map((r) => (r.width / span) * total);
  g.classList.add('dragging');
  follow(
    e,
    (ev) => {
      const d = ((ev.clientX / zoom() - start) / span) * total;
      const w = [...base];
      const pair = base[i] + base[i + 1];
      w[i] = Math.min(pair - MIN_WIDTH, Math.max(MIN_WIDTH, base[i] + d));
      w[i + 1] = pair - w[i];
      layout[widthsKey()] = w.map((f) => Math.round(f * 100) / 100);
      applyWidths();
      placeGutters();
    },
    () => {
      g.classList.remove('dragging');
      scheduleFit();
      save();
    },
  );
}

// ---- Three or four columns -----------------------------------------------------------

function setCount(n) {
  layout.count = n;
  if (n !== count) place(n);
  paintBar();
  save();
  placeGutters();
}

function setFit(on) {
  layout.fit = on;
  fitBoard();
  paintBar();
  save();
  placeGutters();
}

function paintBar() {
  for (const b of $$('#arrange-bar [data-cols]')) b.setAttribute('aria-pressed', String(Number(b.dataset.cols) === count));
  $('#arrange-bar [data-arrange="fit"]')?.setAttribute('aria-pressed', String(layout.fit !== false));
}

// ---- Arrange mode --------------------------------------------------------------------

const cardName = (card) => card.querySelector('h2')?.firstChild?.textContent?.trim() || 'card';

function addControls() {
  for (const card of $$(BOARD_CARDS)) {
    if (card.querySelector(':scope > .card-move')) continue;
    const name = esc(cardName(card));
    card.insertAdjacentHTML(
      'beforeend',
      `<button class="card-move" type="button" title="Drag to move. Arrow keys move it too." aria-label="Move ${name}">${icon('grip')}</button>
       <button class="card-size" type="button" title="Drag to change the height. Double-click to reset it." aria-label="Resize ${name}"></button>`,
    );
    const move = card.querySelector(':scope > .card-move');
    const size = card.querySelector(':scope > .card-size');
    move.addEventListener('pointerdown', (e) => startMove(e, card));
    move.addEventListener('keydown', (e) => keyMove(e, card));
    size.addEventListener('pointerdown', (e) => startResize(e, card));
    size.addEventListener('dblclick', () => resetHeight(card));
    // Up and down step the height by 40px.
    size.addEventListener('keydown', (e) => {
      const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      layout.heights[card.id] = Math.max(MIN_HEIGHT, (layout.heights[card.id] || card.offsetHeight) + d * 40);
      fitBoard();
      save();
    });
  }
  const b = board();
  if (!$('.col-gutter', b)) {
    for (const i of [0, 1, 2]) {
      b.insertAdjacentHTML('beforeend', `<div class="col-gutter" data-gutter="${i}" title="Drag to change the column widths. Double-click to reset." hidden></div>`);
      const g = b.lastElementChild;
      g.addEventListener('pointerdown', (e) => startWiden(e, i));
      g.addEventListener('dblclick', () => {
        layout[widthsKey()] = null;
        applyWidths();
        scheduleFit();
        placeGutters();
        save();
      });
    }
  }
}

function setArranging(on) {
  arranging = on;
  document.body.classList.toggle('arranging', on);
  $('#arrange-btn').setAttribute('aria-pressed', String(on));
  if (on) addControls();
  paintBar();
  showPop($('#arrange-bar'), on);
  placeGutters();
}

// Back to the default board: each card in its spot, and the cards on it back to being a card or
// in the flip card as they start.
async function resetLayout() {
  await chrome.storage.sync.remove(KEY);
  await saveSettings(defaultBoard(await loadSettings()));
  location.reload();
}

export function initLayout() {
  const btn = $('#arrange-btn');
  btn.innerHTML = `${icon('grip')}Arrange cards`;
  btn.addEventListener('click', () => setArranging(!arranging));
  const bar = $('#arrange-bar');
  bar.innerHTML = `<span>Drag a card by ${icon('grip')} to move it, its bottom edge to resize it, or the lines between columns to widen them.</span>
    <span class="cols-pick" role="group" aria-label="Columns">Columns
      <button type="button" data-cols="3" aria-pressed="false">3</button><button type="button" data-cols="4" aria-pressed="false">4</button>
    </span>
    <button class="btn small fit-pick" type="button" data-arrange="fit" aria-pressed="true" title="Cards share the height of the window, so the page doesn’t scroll">Fit to window</button>
    <button class="btn small" type="button" data-arrange="reset">Reset layout</button>
    <button class="btn small primary" type="button" data-arrange="done">Done</button>`;
  bar.addEventListener('click', (e) => {
    const what = e.target.closest('[data-arrange]')?.dataset.arrange;
    const cols = e.target.closest('[data-cols]')?.dataset.cols;
    if (what === 'done') setArranging(false);
    if (what === 'reset') resetLayout();
    if (what === 'fit') setFit(layout.fit === false);
    if (cols) setCount(Number(cols));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && arranging && !document.querySelector('dialog[open]')) setArranging(false);
  });
  addEventListener('resize', () => arranging && placeGutters());
}
