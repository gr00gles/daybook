// Item names for Amazon packages. Amazon's shipping emails name only a category ("1 item:
// Boating Accessories"); the order's own page on amazon.com names what's in it. So Daybook opens
// that page out of sight with your Amazon sign-in in this browser, the way it reads carriers'
// tracking pages (tracking.js), and amazon-page.js reads the item names off it. Each order is
// looked up once and kept on this computer by its number.
import { local } from './util.js';
import { allowFrames, dropFrames, readHidden } from './frames.js';

// v4: with the items' pages (v3 added their pictures; v2 left out the products Amazon suggests).
const KEY = 'amazon:orders:v4'; // { [order number]: { at, items: [names], images: [urls], links: [urls] } or { at, error } }
const RULE = 4103; // the session rule that lets amazon.com's order pages load in Daybook's frames
const PER_RUN = 4; // pages read each time, so a new tab isn't kept busy
const WAIT = 30e3;
const RETRY = 6 * 3600e3; // a page that couldn't be read gets another look after this
const FORGET = 30 * 86400e3;

// An Amazon order number: 113-7709954-3007449.
export const isAmazonOrder = (o) => /^\d{3}-\d{7}-\d{7}$/.test(o || '');
export const loadAmazonOrders = async () => (await local.get(KEY)) || {};
local.remove(['amazon:orders', 'amazon:orders:v2', 'amazon:orders:v3']);
const pageUrl = (order) => `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(order)}`;

// Reads the pages of the orders not looked up yet, a few each time. One Daybook tab does this at
// a time; the others see the names through storage.
export function refreshAmazonOrders(orders) {
  const wanted = [...new Set(orders.filter(isAmazonOrder))];
  if (!wanted.length) return Promise.resolve();
  return navigator.locks.request('amazon-orders', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const now = Date.now();
    let known = await loadAmazonOrders();
    const due = wanted.filter((o) => !known[o] || (known[o].error && now - known[o].at > RETRY)).slice(0, PER_RUN);
    if (!due.length) return;
    try {
      await allowFrames(RULE, ['amazon.com']);
    } catch (err) {
      console.warn('[daybook] Amazon order frames:', err);
      return;
    }
    try {
      for (const [i, order] of due.entries()) {
        const msg = await readHidden(pageUrl(order), { type: 'amazon-order', hosts: ['amazon.com'], wait: WAIT, accept: (m) => m.order === order || m.signedOut });
        known = await loadAmazonOrders();
        if (msg?.signedOut) {
          // Not signed in to Amazon here: every page would say so; look again in a while.
          for (const o of due.slice(i)) known[o] = { at: Date.now(), error: 'Not signed in to amazon.com in this browser' };
          await local.set(KEY, known);
          break;
        }
        known[order] = msg?.items?.length
          ? { at: Date.now(), items: msg.items.slice(0, 8), images: (msg.images || []).slice(0, 8), links: (msg.links || []).slice(0, 8).map((u) => (/^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/.test(u) ? u : '')) }
          : { at: Date.now(), error: msg ? 'No items on the order page' : 'The order page didn’t load' };
        await local.set(KEY, known);
      }
    } finally {
      dropFrames(RULE);
    }
    for (const [o, v] of Object.entries(known)) if (now - (v.at || 0) > FORGET && !wanted.includes(o)) delete known[o];
    await local.set(KEY, known);
  });
}

// Calls `fn` when names arrive, from this page or another.
export function onAmazonOrders(fn) {
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 200);
  });
}
