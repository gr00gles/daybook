// The flip card: one spot on the board where any of the other cards take turns. Each card set to
// "Flip card" in Settings moves into it whole (so it keeps drawing itself as usual), and the card
// turns over to the next every few seconds, holding still under the pointer or while you're in it.
// The tabs along the top pick one by hand. A card with nothing to show (Markets without a key,
// say, which hides itself) sits out until it has.
import { $, $$, esc } from './util.js';
import { icon } from './icons.js';
import { TICKER_CARDS, tickerMode } from './ticker.js';
import { scheduleFit } from './layout.js';

const OUT = 170;
const IN = 300;

export function initFlipCard(S) {
  const box = $('#card-flip');
  const deck = $('#flip-deck');
  const tabs = $('#flip-tabs');
  const keys = Object.keys(TICKER_CARDS).filter((k) => tickerMode(S, k) === 'flip' && S.show[TICKER_CARDS[k].section] !== false);
  if (!keys.length) return;
  for (const k of keys) {
    const card = $(`#${TICKER_CARDS[k].card}`);
    if (!card) continue;
    // Its own size on the board doesn't apply in here.
    card.classList.remove('fixed');
    card.style.removeProperty('--card-h');
    card.classList.add('flip-face', 'flip-off');
    card.dataset.flip = k;
    deck.append(card);
  }

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let current = null; // the card showing
  let turning = false;
  let held = false;
  const faces = () => $$('.flip-face', deck).filter((f) => !f.hidden);

  const paintTabs = () => {
    tabs.innerHTML = faces()
      .map((f) => {
        const c = TICKER_CARDS[f.dataset.flip];
        const on = f === current;
        // The one showing has its name; the rest, just their icons, so a full deck still fits.
        return `<button type="button" role="tab" class="tab${on ? ' on' : ''}" aria-selected="${on}" aria-controls="${f.id}" data-flip="${f.dataset.flip}" title="${esc(c.label)}" aria-label="${esc(c.label)}">${icon(c.icon)}${on ? `<span>${esc(c.label)}</span>` : ''}</button>`;
      })
      .join('');
  };

  const show = (next, dir = 1) => {
    if (!next || next === current || turning) return;
    const from = current;
    current = next;
    paintTabs();
    const reveal = () => {
      from?.classList.add('flip-off');
      next.classList.remove('flip-off');
      scheduleFit();
    };
    if (!from || still.matches) return reveal();
    turning = true;
    from
      .animate([{ transform: 'none', opacity: 1 }, { transform: `rotateY(${-90 * dir}deg)`, opacity: 0.3 }], { duration: OUT, easing: 'cubic-bezier(.5, 0, .9, .5)' })
      .finished.then(() => {
        reveal();
        return next.animate([{ transform: `rotateY(${90 * dir}deg)`, opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: IN, easing: 'cubic-bezier(.2, .8, .2, 1)' }).finished;
      })
      .catch(() => {})
      .finally(() => (turning = false));
  };

  // A card hides or shows itself as it has something to show: keep one showing, and the tabs right.
  const settle = () => {
    const list = faces();
    box.hidden = !list.length;
    if (!list.includes(current)) {
      current?.classList.add('flip-off');
      current = list[0] || null;
      current?.classList.remove('flip-off');
      scheduleFit();
    }
    paintTabs();
  };
  for (const f of $$('.flip-face', deck)) new MutationObserver(settle).observe(f, { attributes: true, attributeFilter: ['hidden'] });

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-flip]');
    if (!b) return;
    const list = faces();
    const next = list.find((f) => f.dataset.flip === b.dataset.flip);
    show(next, list.indexOf(next) < list.indexOf(current) ? -1 : 1);
  });
  // Left and right on the tabs turn it too.
  tabs.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const list = faces();
    show(list[(list.indexOf(current) + d + list.length) % list.length], d);
    tabs.querySelector('.on')?.focus();
  });

  const hold = (on) => () => (held = on || box.matches(':hover, :focus-within'));
  box.addEventListener('pointerenter', hold(true));
  box.addEventListener('pointerleave', hold(false));
  box.addEventListener('focusin', hold(true));
  box.addEventListener('focusout', () => setTimeout(hold(false)));
  const every = Number(S.flip?.every) || 0;
  if (every > 0)
    setInterval(() => {
      const list = faces();
      if (held || turning || document.hidden || list.length < 2 || document.querySelector('dialog[open]')) return;
      show(list[(list.indexOf(current) + 1) % list.length]);
    }, every * 1000);
  settle();
}
