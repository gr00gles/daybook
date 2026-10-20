// A stack of cards flipped one at a time: the front card in full, the next two peeking out
// behind it, the card just flipped past dropping away. Markup (styles under "Rolodex"):
//   <div class="rolo" tabindex="0">
//     <div class="rolo-stack"><div class="rolo-card">…</div>…</div>
//     <div class="rolo-nav"><button data-rolo="prev"> <span class="rolo-pos"></span> <button data-rolo="next"></div>
//   </div>
// Hovering or focusing holds it still; the wheel, the arrow keys and the buttons flip it.
// The returned stop() clears its timer; call it before replacing the markup.
export function rolodex(root, { every = 8000, start = 0, onFlip } = {}) {
  const cards = [...root.querySelectorAll('.rolo-card')];
  const n = cards.length;
  let current = n ? Math.min(Math.max(0, start), n - 1) : 0;
  let held = false;

  const place = () => {
    cards.forEach((card, i) => {
      const pos = (i - current + n) % n;
      card.dataset.pos = pos === n - 1 && n > 3 ? 'gone' : pos <= 2 ? String(pos) : 'wait';
      card.setAttribute('aria-hidden', String(pos !== 0));
      for (const el of card.querySelectorAll('a, button')) el.tabIndex = pos === 0 ? 0 : -1;
    });
    const posEl = root.querySelector('.rolo-pos');
    if (posEl) posEl.textContent = n ? `${current + 1} of ${n}` : '';
  };
  const flip = (step) => {
    if (n < 2) return;
    current = (current + step + n) % n;
    place();
    onFlip?.(current);
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rolo]');
    if (b) flip(b.dataset.rolo === 'prev' ? -1 : 1);
  });
  root.addEventListener('pointerenter', () => (held = true));
  root.addEventListener('pointerleave', () => (held = false));
  root.addEventListener('focusin', () => (held = true));
  root.addEventListener('focusout', () => (held = false));
  let wheelAt = 0;
  root.addEventListener(
    'wheel',
    (e) => {
      if (n < 2 || !e.target.closest('.rolo-stack')) return;
      e.preventDefault();
      if (Date.now() - wheelAt < 350) return;
      wheelAt = Date.now();
      flip(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
  root.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    flip(step);
    if (root.contains(document.activeElement) && document.activeElement !== root) cards[current]?.querySelector('a, button')?.focus();
  });

  place();
  const timer =
    n > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches
      ? setInterval(() => !held && document.visibilityState === 'visible' && flip(1), every)
      : null;
  return { flip, stop: () => clearInterval(timer) };
}
