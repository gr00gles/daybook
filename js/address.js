// Address suggestions under the event form's Location field, as you type: your recent places
// first, then addresses from Photon (OpenStreetMap, no key) nearest to you, like the search
// bar's Maps mode. Picking one fills the field and adds it to your recent places.
import { esc } from './util.js';
import { icon } from './icons.js';
import { suggest, recentMatching, recentPlaces, remember } from './places.js';

export function attachAddressSuggest(input) {
  if (!input) return;
  const list = document.createElement('ul');
  list.className = 'addr-list';
  list.id = `${input.id}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Address suggestions');
  list.hidden = true;
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  let items = [];
  let active = -1;
  let timer;
  let asked = '';
  let fromPhoton = false;

  const close = () => {
    list.hidden = true;
    items = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const paint = (note = '') => {
    if (!items.length && !note) return close();
    list.innerHTML =
      items
        .map(
          (it, i) => `<li id="${list.id}-${i}" role="option" class="place${i === active ? ' on' : ''}${it.recent ? ' recent' : ''}" aria-selected="${i === active}" data-addr="${i}">
        ${icon(it.recent ? 'clock' : 'pin')}<span class="place-text"><span class="place-title">${esc(it.title)}</span>${it.detail ? `<span class="place-detail">${esc(it.detail)}</span>` : ''}</span>
      </li>`,
        )
        .join('') +
      (note ? `<li class="places-note" role="presentation">${esc(note)}</li>` : '') +
      (fromPhoton && items.some((it) => !it.recent) ? '<li class="addr-credit" role="presentation">Suggestions © OpenStreetMap contributors, via Photon</li>' : '');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `${list.id}-${active}` : '');
    list.querySelector('.place.on')?.scrollIntoView({ block: 'nearest' });
  };

  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    remember(it);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    asked = it.label;
  };

  const update = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q === asked) return;
    asked = q;
    fromPhoton = false;
    if (q.length < 3) {
      // Nothing much typed yet: your recent places, if any.
      items = q ? [] : recentPlaces().slice(0, 5).map((h) => ({ ...h, recent: true }));
      active = -1;
      return document.activeElement === input ? paint() : close();
    }
    const recent = recentMatching(q).slice(0, 3).map((h) => ({ ...h, recent: true }));
    items = recent;
    active = -1;
    paint(recent.length ? '' : 'Looking up addresses…');
    timer = setTimeout(async () => {
      try {
        const found = await suggest(q);
        if (q !== input.value.trim() || document.activeElement !== input) return;
        fromPhoton = true;
        items = [...recent, ...found.filter((it) => !recent.some((r) => r.label === it.label))].slice(0, 6);
        paint(items.length ? '' : 'No matching addresses. What you typed is kept as it is.');
      } catch (err) {
        if (err.name === 'AbortError' || q !== input.value.trim()) return;
        items = recent;
        paint('Address suggestions aren’t available right now.');
      }
    }, 250);
  };

  input.addEventListener('input', (e) => {
    // Our own event after a pick: leave the list closed.
    if (!e.isTrusted) return;
    update();
  });
  input.addEventListener('focus', () => {
    asked = null;
    update();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown') {
        asked = null;
        update();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + (active < 0 && e.key === 'ArrowUp' ? 1 : 0)) % items.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      // Pick the address instead of saving the form.
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      // Close the list, not the whole form.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close();
  });
  // Clicking an address keeps the cursor in the field.
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const li = e.target.closest('[data-addr]');
    if (li) pick(Number(li.dataset.addr));
  });
}
