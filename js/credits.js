// Where the page's data comes from, in one line of soft text under the board rather than on
// each card. Each part sets its own credit (or clears it with '') as what it shows changes.
import { $ } from './util.js';

const parts = new Map(); // key -> HTML, in the order first set

export function setCredit(key, html) {
  if ((parts.get(key) || '') === (html || '')) return;
  if (html) parts.set(key, html);
  else parts.delete(key);
  const el = $('#credits');
  if (!el) return;
  el.innerHTML = [...parts.values()].join(' · ');
  el.hidden = !parts.size;
}
