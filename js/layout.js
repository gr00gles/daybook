// Arrange mode: drag cards between and within the board's columns, drag a card's bottom
// edge to set its height, drag the lines between columns to change their widths, switch
// the board between three columns and four, and turn fitting the window on or off.
// The layout is saved under its own key in chrome.storage.sync, apart from Settings:
//   { v: 1, rev: 2, count: 3 | 4, fit: false, cols: { day: [card ids], mail: [...], out: [...] },
//     cols4: { day, mail, out, more }, widths: [fr × 3], widths4: [fr × 4], heights: { id: px } }
// Three and four columns each keep their own arrangement and widths; heights are shared. With
// no count saved, windows at least AUTO_FOUR wide get four, arranged as FOUR. Layouts saved
// before rev 2 keep only their count: the cards moved to new spots that fit the window.
// A card's height never scrolls: below its natural height it drops whole items (emails, games,
// events, list rows) from the end until it fits, and grows back as there's room again.
// While the columns sit side by side, each also fits the window (see fitColumn).
// Cards a saved layout doesn't name (a card added in a later version) keep their default spot.
import { $, $$, esc, showPop } from './util.js';
import { icon } from './icons.js';

const KEY = 'layout';
const REV = 2;
const DEFAULT_WIDTHS = { 3: [1.1, 1.2, 1], 4: [1, 1.3, 1, 0.9] };
// Four columns: the day, the month with the small cards, mail, and things to read or watch.
const FOUR = {
  day: ['card-today', 'card-notes'],
  mail: ['card-month', 'card-stocks', 'card-teams'],
  out: ['card-deliveries', 'card-mail', 'card-area'],
  more: ['card-youtube', 'card-news'],
};
const AUTO_FOUR = 1480;
const MIN_WIDTH = 0.5;
const MIN_HEIGHT = 140;
const FIT_MIN = 140; // the shortest a card with a list gets when fitting the window
const FIT_BOTTOM = 16; // room kept under the cards
const FIT_SLACK = 1 / 3; // how much of a window the page may scroll to keep the columns fitted

let layout = { v: 1, rev: REV, count: null, fit: true, cols: {}, cols4: null, widths: null, widths4: null, heights: {} };
let arranging = false;
let count = 3; // columns on the board now
let defaults = null; // where each card sits in newtab.html

const board = () => $('.board');
const allColumns = () => $$('.board > .col');
const columns = () => allColumns().filter((col) => !col.hidden);
const colKey = (col) => [...col.classList].find((c) => c.startsWith('col-'))?.slice(4);
const cardsIn = (col) => [...col.children].filter((el) => el.matches('.card[id]'));
const shown = (card) => !card.hidden && card.offsetParent !== null;
// True while the board shows every column side by side: the lines between them can be
// dragged, and the columns fit the window.
const allAcross = () => {
  const cols = columns().map((c) => c.getBoundingClientRect());
  return cols.length === count && cols.every((r, i) => i === 0 || (Math.abs(r.top - cols[0].top) < 2 && cols[i - 1].right < r.left));
};
const widthsKey = () => (count === 4 ? 'widths4' : 'widths');
const wantedCount = () => layout.count || (innerWidth >= AUTO_FOUR ? 4 : 3);

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
        if (card?.matches('.board .card')) col.append(card);
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

// The items a card can drop: entries of its lists, outermost only, in page order. Lists inside
// [data-keep] (a day's schedule opened under the month) always show whole.
const itemsOf = (card) =>
  [...card.querySelectorAll(':scope > :not(.card-head, .card-foot) :is(ol, ul) > li')].filter((li) => !li.parentElement.closest('li, [data-keep]'));

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

function applyHeight(card) {
  const h = layout.heights[card.id];
  card.classList.toggle('sized', Boolean(h));
  if (h) card.style.setProperty('--card-h', `${h}px`);
  else card.style.removeProperty('--card-h');
}

// ---- Fitting the window ----------------------------------------------------------------

// Back to a card's own height: every item, no height from fitting.
function release(card) {
  card.classList.remove('fitted', 'stretched');
  card.style.removeProperty('--fit-h');
  card.style.removeProperty('--fit-min');
  showFirst(itemsOf(card), Infinity);
}

// How a column's cards can give: their own heights (capped by one set by dragging), which of
// them can drop items, and the least the column can take with those cut to FIT_MIN.
function measureColumn(col) {
  const cards = cardsIn(col).filter(shown);
  col.classList.add('fits'); // lifts the cards' own scroll limits while measuring
  cards.forEach(release);
  const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
  const all = cards.map((card) => {
    const cap = layout.heights[card.id] || Infinity;
    const notes = Boolean(card.querySelector(':scope > textarea'));
    return { card, cap, notes, flex: notes || itemsOf(card).length > 1, h: Math.min(card.offsetHeight, cap) };
  });
  const fixed = gap * Math.max(0, cards.length - 1) + all.reduce((sum, x) => sum + (x.flex ? 0 : x.h), 0);
  const least = fixed + all.reduce((sum, x) => sum + (x.flex ? Math.min(x.h, FIT_MIN) : 0), 0);
  return { col, cards, all, fixed, least };
}

// Fits a column into `room` pixels. Cards with lists share what the other cards leave: the
// shorter ones keep their height, the rest split the remainder and drop whole items to fit.
// Notes takes whatever is still left (at least FIT_MIN), and the last card reaches the bottom
// so the columns end on one line.
function fitColumn({ col, cards, all, fixed }, room) {
  if (!cards.length) return;
  const lists = all.filter((x) => x.flex && !x.notes);
  const notes = all.filter((x) => x.notes);
  const least = (x) => Math.min(x.h, FIT_MIN);
  let free = room - fixed - notes.reduce((sum, x) => sum + least(x), 0);
  let n = lists.length;
  for (const x of [...lists].sort((a, b) => a.h - b.h)) {
    const h = Math.min(x.h, free / n);
    fitItems(x.card, Math.floor(h));
    free -= h;
    n--;
  }
  const used = () => cards.at(-1).getBoundingClientRect().bottom - col.getBoundingClientRect().top;
  for (const x of notes) {
    x.card.classList.add('fitted');
    x.card.style.setProperty('--fit-h', `${least(x)}px`);
    x.card.style.setProperty('--fit-h', `${Math.floor(Math.min(x.cap, Math.max(least(x), least(x) + room - used())))}px`);
  }
  const last = cards.at(-1);
  const short = Math.floor(room - used());
  if (short >= 1) {
    last.classList.add('stretched');
    last.style.setProperty('--fit-min', `${last.offsetHeight + short}px`);
  }
}

// While the columns sit side by side, they all end on one line: the bottom of the window, or
// as near it as the fullest column can get with its lists cut to FIT_MIN, when that's within
// FIT_SLACK of a window (the page scrolls that little). Further than that, cutting the lists
// wouldn't spare much scrolling, so every card keeps its full height. A height set by
// dragging still caps a card.
function fitBoard() {
  const cols = columns();
  const measured = layout.fit !== false && allAcross() ? cols.map(measureColumn) : [];
  const top = (col) => col.getBoundingClientRect().top + scrollY;
  const bottom = Math.max(innerHeight - FIT_BOTTOM, ...measured.map((m) => top(m.col) + m.least));
  if (measured.length && bottom <= innerHeight * (1 + FIT_SLACK)) {
    for (const m of measured) fitColumn(m, bottom - top(m.col));
    return;
  }
  for (const col of cols) {
    col.classList.remove('fits');
    for (const card of cardsIn(col)) {
      release(card);
      fitItems(card, layout.heights[card.id]);
    }
  }
}

// Cards re-render their lists on every refresh, and the window and the band above change
// size; fit again once per frame after any of it.
let fitting = 0;
function scheduleFit() {
  if (!fitting) fitting = requestAnimationFrame(() => {
    fitting = 0;
    fitBoard();
  });
}
function watchCards() {
  for (const card of $$('.board .card[id]')) new MutationObserver(scheduleFit).observe(card, { childList: true, subtree: true, characterData: true });
  let width = board().offsetWidth;
  new ResizeObserver(() => {
    if (board().offsetWidth === width) return;
    width = board().offsetWidth;
    scheduleFit();
  }).observe(board());
  new ResizeObserver(scheduleFit).observe($('.sky'));
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
  for (const card of $$('.board .card[id]')) applyHeight(card);
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
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  });
  let col = under.filter((c) => c.getBoundingClientRect().top <= y).at(-1) || under[0];
  if (!col) {
    col = cols.reduce((best, c) => {
      const r = c.getBoundingClientRect();
      const d = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      return !best || d < best.d ? { c, d } : best;
    }, null)?.c;
  }
  if (!col) return null;
  const before = cardsIn(col).find((c) => {
    if (c === dragged || !shown(c)) return false;
    const r = c.getBoundingClientRect();
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
      const spot = dropSpot(ev.clientX, ev.clientY, card);
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
  const top = card.getBoundingClientRect().top;
  follow(
    e,
    (ev) => {
      layout.heights[card.id] = Math.max(MIN_HEIGHT, Math.round(ev.clientY - top));
      applyHeight(card);
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
  applyHeight(card);
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
  const br = b.getBoundingClientRect();
  const cols = columns().map((c) => c.getBoundingClientRect());
  gutters.forEach((g, i) => {
    g.hidden = i >= cols.length - 1;
    if (!g.hidden) g.style.left = `${(cols[i].right + cols[i + 1].left) / 2 - br.left}px`;
  });
}

function startWiden(e, i) {
  const g = e.currentTarget;
  const rects = columns().map((c) => c.getBoundingClientRect());
  const total = (layout[widthsKey()] || DEFAULT_WIDTHS[count]).reduce((a, b) => a + b, 0);
  const span = rects.reduce((a, r) => a + r.width, 0);
  const start = e.clientX;
  const base = rects.map((r) => (r.width / span) * total);
  g.classList.add('dragging');
  follow(
    e,
    (ev) => {
      const d = ((ev.clientX - start) / span) * total;
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
  for (const card of $$('.board .card[id]')) {
    if (card.querySelector(':scope > .card-move')) continue;
    const name = esc(cardName(card));
    card.insertAdjacentHTML(
      'beforeend',
      `<button class="card-move" type="button" title="Drag to move. Arrow keys move it too." aria-label="Move ${name}">${icon('grip')}</button>
       <button class="card-size" type="button" title="Drag to change the height. Double-click to fit the contents." aria-label="Resize ${name}"></button>`,
    );
    const move = card.querySelector(':scope > .card-move');
    const size = card.querySelector(':scope > .card-size');
    move.addEventListener('pointerdown', (e) => startMove(e, card));
    move.addEventListener('keydown', (e) => keyMove(e, card));
    size.addEventListener('pointerdown', (e) => startResize(e, card));
    size.addEventListener('dblclick', () => resetHeight(card));
    // Up and down show one item fewer or more; cards without a list step by 40px.
    size.addEventListener('keydown', (e) => {
      const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const items = itemsOf(card);
      if (items.length) {
        const k = Math.min(items.length, Math.max(1, items.filter((li) => !li.hasAttribute('data-clip')).length + d));
        release(card);
        showFirst(items, k);
        layout.heights[card.id] = card.offsetHeight;
      } else {
        layout.heights[card.id] = Math.max(MIN_HEIGHT, (layout.heights[card.id] || card.offsetHeight) + d * 40);
      }
      applyHeight(card);
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

async function resetLayout() {
  await chrome.storage.sync.remove(KEY);
  location.reload();
}

export function initLayout() {
  const btn = $('#arrange-btn');
  btn.innerHTML = icon('grip');
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
