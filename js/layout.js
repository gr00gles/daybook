// Arrange mode: drag cards between and within the board's columns, drag a card's bottom
// edge to set its height, drag the lines between columns to change their widths.
// The layout is saved under its own key in chrome.storage.sync, apart from Settings:
//   { v: 1, cols: { day: [card ids], mail: [...], out: [...] }, widths: [fr, fr, fr], heights: { id: px } }
// Cards a saved layout doesn't name (a card added in a later version) keep their default spot.
import { $, $$, esc, showPop } from './util.js';
import { icon } from './icons.js';

const KEY = 'layout';
const DEFAULT_WIDTHS = [1.25, 1, 0.95];
const MIN_WIDTH = 0.5;
const MIN_HEIGHT = 140;

let layout = { v: 1, cols: {}, widths: null, heights: {} };
let arranging = false;

const board = () => $('.board');
const columns = () => $$('.board > .col');
const colKey = (col) => [...col.classList].find((c) => c.startsWith('col-'))?.slice(4);
const cardsIn = (col) => [...col.children].filter((el) => el.matches('.card[id]'));
const shown = (card) => !card.hidden && card.offsetParent !== null;

async function save() {
  layout.cols = Object.fromEntries(columns().map((col) => [colKey(col), cardsIn(col).map((c) => c.id)]));
  await chrome.storage.sync.set({ [KEY]: layout });
}

function applyWidths() {
  const w = layout.widths;
  board().style.setProperty('--board-cols', w ? w.map((f) => `minmax(0, ${f}fr)`).join(' ') : null);
  if (!w) board().style.removeProperty('--board-cols');
}

function applyHeight(card) {
  const h = layout.heights[card.id];
  card.classList.toggle('sized', Boolean(h));
  if (h) card.style.setProperty('--card-h', `${h}px`);
  else card.style.removeProperty('--card-h');
}

// Runs before the cards render, so a saved layout doesn't jump into place.
export async function applyLayout() {
  try {
    const saved = (await chrome.storage.sync.get(KEY))[KEY];
    if (saved?.v === 1) layout = { v: 1, cols: saved.cols || {}, widths: saved.widths || null, heights: saved.heights || {} };
  } catch {}
  const byKey = Object.fromEntries(columns().map((col) => [colKey(col), col]));
  for (const [key, ids] of Object.entries(layout.cols)) {
    const col = byKey[key];
    if (!col || !Array.isArray(ids)) continue;
    for (const id of ids) {
      const card = document.getElementById(id);
      if (card?.matches('.board .card')) col.append(card);
    }
  }
  if (layout.widths?.length !== 3) layout.widths = null;
  applyWidths();
  for (const card of $$('.board .card[id]')) applyHeight(card);
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
function dropSpot(x, y, dragged) {
  const cols = columns().filter((c) => c.offsetParent !== null);
  let col = cols.find((c) => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  });
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

// The lines between columns only make sense while the board shows three side by side.
const threeAcross = () => {
  const cols = columns();
  return cols.length === 3 && Math.abs(cols[0].getBoundingClientRect().top - cols[2].getBoundingClientRect().top) < 2 && cols[0].getBoundingClientRect().right < cols[2].getBoundingClientRect().left;
};

function placeGutters() {
  const b = board();
  const gutters = $$('.col-gutter', b);
  if (!arranging || !threeAcross()) {
    for (const g of gutters) g.hidden = true;
    return;
  }
  const br = b.getBoundingClientRect();
  const cols = columns().map((c) => c.getBoundingClientRect());
  gutters.forEach((g, i) => {
    g.hidden = false;
    g.style.left = `${(cols[i].right + cols[i + 1].left) / 2 - br.left}px`;
  });
}

function startWiden(e, i) {
  const g = e.currentTarget;
  const rects = columns().map((c) => c.getBoundingClientRect());
  const total = (layout.widths || DEFAULT_WIDTHS).reduce((a, b) => a + b, 0);
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
      layout.widths = w.map((f) => Math.round(f * 100) / 100);
      applyWidths();
      placeGutters();
    },
    () => {
      g.classList.remove('dragging');
      save();
    },
  );
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
    size.addEventListener('keydown', (e) => {
      const d = { ArrowUp: -40, ArrowDown: 40 }[e.key];
      if (!d) return;
      e.preventDefault();
      layout.heights[card.id] = Math.max(MIN_HEIGHT, (layout.heights[card.id] || card.offsetHeight) + d);
      applyHeight(card);
      save();
    });
  }
  const b = board();
  if (!$('.col-gutter', b)) {
    for (const i of [0, 1]) {
      b.insertAdjacentHTML('beforeend', `<div class="col-gutter" data-gutter="${i}" title="Drag to change the column widths. Double-click to reset." hidden></div>`);
      const g = b.lastElementChild;
      g.addEventListener('pointerdown', (e) => startWiden(e, i));
      g.addEventListener('dblclick', () => {
        layout.widths = null;
        applyWidths();
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
    <button class="btn small" type="button" data-arrange="reset">Reset layout</button>
    <button class="btn small primary" type="button" data-arrange="done">Done</button>`;
  bar.addEventListener('click', (e) => {
    const what = e.target.closest('[data-arrange]')?.dataset.arrange;
    if (what === 'done') setArranging(false);
    if (what === 'reset') resetLayout();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && arranging && !document.querySelector('dialog[open]')) setArranging(false);
  });
  addEventListener('resize', () => arranging && placeGutters());
}
