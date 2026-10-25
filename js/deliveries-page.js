// The Deliveries page: every package the Deliveries card has, on their way first, then the ones
// delivered, each with everything in the box. The card keeps its list in chrome.storage.local
// (SHOWN) whenever it draws, so this page shows what a new tab last found and follows it.
import { $, local, updatedText } from './util.js';
import { loadSettings } from './settings.js';
import { icon } from './icons.js';
import { deliveryRows, SHOWN } from './packages.js';

const S = await loadSettings();
if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
$('#dp-back').insertAdjacentHTML('afterbegin', icon('chevron-left'));

function paint(saved) {
  const list = saved?.list || [];
  const coming = list.filter((d) => d.state !== 'delivered');
  const done = list.filter((d) => d.state === 'delivered');
  $('#dp-status').textContent = list.length ? `${coming.length} on the way${done.length ? `, ${done.length} delivered` : ''}` : 'Nothing on the way';
  $('#dp-updated').textContent = saved?.at ? updatedText(saved.at) : '';
  const part = (name, l) => (l.length ? `<h3 class="eyebrow">${name}</h3>${deliveryRows(l, Infinity, { full: true })}` : '');
  $('#dp-body').innerHTML = list.length
    ? part('On the way', coming) + part('Delivered', done)
    : '<p class="quiet">Shipping emails show up here with their delivery dates. Open a new tab to look for new ones.</p>';
}

paint(await local.get(SHOWN));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SHOWN]) paint(changes[SHOWN].newValue);
});
