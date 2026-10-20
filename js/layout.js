// Arrange mode: drag cards between and within the board's columns, drag a card's bottom
// edge to set its height, drag the lines between columns to change their widths, and switch
// the board between three columns and four.
// The layout is saved under its own key in chrome.storage.sync, apart from Settings:
//   { v: 1, count: 3 | 4, cols: { day: [card ids], mail: [...], out: [...] }, cols4: { day, mail, out, more },
//     widths: [fr × 3], widths4: [fr × 4], heights: { id: px } }
// Three and four columns each keep their own arrangement and widths; heights are shared. With
// no count saved, windows at least AUTO_FOUR wide get four. Four columns start from the
// three-column arrangement with YouTube and Notes moved to the fourth.
// A card's height never scrolls: below its natural height it drops whole items (emails, games,
// events, list rows) from the end until it fits, and grows back as there's room again.
// Cards a saved layout doesn't name (a card added in a later version) keep their default spot.
import { $, $$, esc, showPop } from './util.js';
import { icon } from './icons.js';

const KEY = 'layout';
const DEFAULT_WIDTHS = { 3: [1.25, 1, 0.95], 4: [1.3, 1, 1, 1] };
const FOURTH = ['card-youtube', 'card-notes'];
const AUTO_FOUR = 1480;
const MIN_WIDTH = 0.5;
const MIN_HEIGHT = 140;

let layout = { v: 1, count: null, cols: {}, cols4: null, widths: null, widths4: null, heights: {} };
let arranging = false;
let count = 3; // columns on the board now
let defaults = null; // where each card sits in newtab.html

const board = () => $('.board');
const allColumns = () => $$('.board > .col');
const columns = () => allColumns().filter((col) => !col.hidden);
const colKey = (col) => [...col.classList].find((c) => c.startsWith('col-'))?.slice(4);
const cardsIn = (col) => [...col.children].filter((el) => el.matches('.card[id]'));
const shown = (card) => !card.hidden && card.offsetParent !== null;
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
  if (n === 4) {
    if (!layout.cols4) put(layout.cols);
    put({ more: FOURTH });
    put(layout.cols4);
  } else put(layout.cols);
  count = n;
  byKey.more.hidden = n !== 4;
  board().dataset.cols = String(n);
  applyWidths();
}

// The items a card can drop: entries of its lists, outermost only, in page order.
const itemsOf = (card) =>
  [...card.querySelectorAll(':scope > :not(.card-head, .card-foot) :is(ol, ul) > li')].filter((li) => !li.parentElement.closest('li'));

// Shows only the first k items.
function showFirst(items, k) {
  items.forEach((li, i) => li.toggleAttribute('data-clip', i >= k));
}

function fitItems(card) {
  const h = layout.heights[card.id];
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
  fitItems(card);
}

// Cards re-render their lists on every refresh; fit them again after each one.
const pending = new Set();
const refit = (card) => {
  if (!layout.heights[card.id] || pending.has(card)) return;
  pending.add(card);
  requestAnimationFrame(() => {
    pending.delete(card);
    fitItems(card);
  });
};
const refitAll = () => {
  for (const card of $$('.board .card.sized')) refit(card);
};
function watchCards() {
  for (const card of $$('.board .card[id]')) new MutationObserver(() => refit(card)).observe(card, { childList: true, subtree: true, characterData: true });
  let width = board().offsetWidth;
  new ResizeObserver(() => {
    if (board().offsetWidth === width) return;
    width = board().offsetWidth;
    refitAll();
  }).observe(board());
}

// Runs before the cards render, so a saved layout doesn't jump into place.
export async function applyLayout() {
  try {
    const saved = (await chrome.storage.sync.get(KEY))[KEY];
    if (saved?.v === 1)
      layout = {
        v: 1,
        count: [3, 4].includes(saved.count) ? saved.count : null,
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
    refitAll();
    paintCount();
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
  save();
  placeGutters();
}

// ---- Column widths -------------------------------------------------------------------

// The lines between columns only make sense while the board shows them all side by side.
const allAcross = () => {
  const cols = columns().map((c) => c.getBoundingClientRect());
  return cols.length === count && cols.every((r, i) => i === 0 || (Math.abs(r.top - cols[0].top) < 2 && cols[i - 1].right < r.left));
};

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
      refitAll();
      save();
    },
  );
}

// ---- Three or four columns -----------------------------------------------------------

function setCount(n) {
  layout.count = n;
  if (n !== count) {
    place(n);
    refitAll();
  }
  paintCount();
  save();
  placeGutters();
}

function paintCount() {
  for (const b of $$('#arrange-bar [data-cols]')) b.setAttribute('aria-pressed', String(Number(b.dataset.cols) === count));
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
        showFirst(items, k);
        layout.heights[card.id] = card.offsetHeight;
      } else {
        layout.heights[card.id] = Math.max(MIN_HEIGHT, (layout.heights[card.id] || card.offsetHeight) + d * 40);
      }
      applyHeight(card);
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
        refitAll();
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
  paintCount();
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
    <button class="btn small" type="button" data-arrange="reset">Reset layout</button>
    <button class="btn small primary" type="button" data-arrange="done">Done</button>`;
  bar.addEventListener('click', (e) => {
    const what = e.target.closest('[data-arrange]')?.dataset.arrange;
    const cols = e.target.closest('[data-cols]')?.dataset.cols;
    if (what === 'done') setArranging(false);
    if (what === 'reset') resetLayout();
    if (cols) setCount(Number(cols));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && arranging && !document.querySelector('dialog[open]')) setArranging(false);
  });
  addEventListener('resize', () => arranging && placeGutters());
}
