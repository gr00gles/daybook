// Shipping emails, read in full, read or not, for the Deliveries card: the tracking number,
// the carrier, the day it's due and what's in the box are usually inside the email, not in its
// subject or preview.
//
// Gmail: Daybook opens Gmail's own page out of sight (frames.js) with a search for shipping
// emails in the folders picked for Deliveries, signed in the way you already are in this
// browser, and gmail-page.js reads the results and each email's printable page. No Google API
// and no permission to give.
// Outlook: the same Outlook sign-in the Unread card uses searches the whole mailbox or the
// folders picked.
// Each email becomes { msgId, subject, from, fromAddr, at, url, snippet, body (its text),
// links (its tracking links), picture (the product's), items (the products it names),
// full: true } for packages.js to read.
import { cached, hash, local } from './util.js';
import { graph } from './msauth.js';
import { allowFrames, dropFrames, readHidden } from './frames.js';
import { aboutPackage } from './packages.js';
import { GMAIL_FOLDERS } from './settings.js';

const KEY = 'pkg:mail';
const REPORT = 'pkg:mail:report'; // what the last search found in each account, for Settings
const RULE = 4102; // the session rule that lets Gmail's page load in Daybook's frames
const DAYS = 14;
const MAX_ACCOUNTS = 3;
const BODY_CHARS = 15000;
const GMAIL_WORDS = `{subject:shipped subject:shipping subject:delivered subject:delivery subject:arriving subject:arrived subject:shipment subject:package subject:order subject:ordered subject:tracking "tracking number" "out for delivery" "has shipped" "on its way" "was delivered" "estimated delivery" "expected delivery"}`;

const labelNames = (labels) => String(labels || '').split(',').map((l) => l.trim()).filter(Boolean);
// What an account's search looks in ({ folders, labels }; see shippingFolders), as Gmail search
// words: All mail (everything but Spam and Trash) leaves out Promotions and Social unless they're
// ticked too; otherwise any of the folders and labels ticked. Null with nothing ticked.
export function gmailWhere({ folders = [], labels = '' }) {
  if (folders.includes('all')) return ['promotions', 'social'].filter((k) => !folders.includes(k)).map((k) => `-category:${k}`).join(' ');
  // Gmail's search spells a label in lower case, with dashes for spaces and slashes.
  const terms = [
    ...folders.filter((k) => GMAIL_FOLDERS[k]).map((k) => GMAIL_FOLDERS[k].search),
    ...labelNames(labels).map((l) => `label:${l.toLowerCase().replace(/[\s/]+/g, '-').replace(/["{}()]/g, '')}`),
  ];
  return terms.length ? `{${terms.join(' ')}}` : null;
}
const gmailSearch = (where) => `newer_than:${DAYS}d ${gmailWhere(where)} ${GMAIL_WORDS}`.replace(/ +/g, ' ');
const OUTLOOK_SEARCH = 'shipped OR shipping OR delivered OR delivery OR arriving OR arrived OR shipment OR package OR tracking OR ordered';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An email's HTML as lines of text (one per paragraph, cell or line break), and its links.
export function htmlText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html'); // parsing loads nothing
  for (const el of doc.querySelectorAll('style, script, head, title, noscript')) el.remove();
  const BLOCK = /^(?:address|article|aside|blockquote|br|center|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/i;
  const out = [];
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out.push(n.nodeValue);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const block = BLOCK.test(n.tagName);
        if (block) out.push('\n');
        walk(n);
        if (block) out.push('\n');
      }
    }
  };
  walk(doc.body || doc);
  const text = out
    .join('')
    .split('\n')
    // Emails pad their preview text with invisible characters.
    .map((l) => l.replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤ㅤ﻿ﾠ]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { text, doc };
}

// A link's address, unwrapped from the click-counting links stores use.
function unwrap(href) {
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(href);
      if (next === href) break;
      href = next;
    } catch {
      break;
    }
  }
  return href;
}

// Links that may carry a tracking number.
function trackingLinks(doc) {
  const out = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = unwrap(a.getAttribute('href') || '');
    if (/track|trk|tlabels/i.test(href)) out.add(href.slice(0, 600));
    if (out.size >= 12) break;
  }
  return [...out];
}

const NOT_PRODUCT = /logo|icon|pixel|spacer|blank|beacon|track|open\.|\/o\.gif|badge|social|facebook|twitter|instagram|pinterest|tiktok|youtube|linkedin|app[-_ ]?store|google[-_ ]?play|banner|header|footer|divider|rating|stars?\b|arrow|button|btn|signature|qr|completed|pending|progress|status|marketing|hero|promo|confirm|deliver|truck|survey/i;

// The pictures in an email that look like products, in order, with how much: not a logo, a
// tracking pixel, a social button, a banner or a progress bar.
function productPictures(doc, title = '') {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const out = [];
  for (const img of doc.querySelectorAll('img')) {
    let src = (img.getAttribute('src') || '').trim();
    // Gmail shows email pictures through its own copier, with the original after the #.
    const original = src.match(/#(https:\/\/.+)$/)?.[1];
    if (original) src = original;
    if (!/^https:\/\//i.test(src)) continue;
    const alt = img.getAttribute('alt') || '';
    const w = parseInt(img.getAttribute('width') || img.style.width, 10) || 0;
    const h = parseInt(img.getAttribute('height') || img.style.height, 10) || 0;
    if (NOT_PRODUCT.test(`${src} ${alt} ${img.className}`)) continue;
    if ((w && w < 48) || (h && h < 48) || (w && h && (w / h > 2.2 || h / w > 2.2))) continue;
    let score = 0;
    if (/\/images\/I\//.test(src)) score += 5; // Amazon's product pictures
    if (alt && alt.toLowerCase().split(/[^a-z0-9]+/).some((x) => words.has(x))) score += 3;
    if (/product|item|catalog|sku|cdn\.shopify|scene7|\/is\/image\/|etsystatic|walmartimages|ebayimg|bbystatic/i.test(src)) score += 2;
    if (w >= 64 && h >= 64) score += 1;
    // Big alone isn't enough: stores' emails are full of big pictures that aren't the product.
    if (score >= 2) out.push({ src, score });
  }
  return out;
}

// Of those, the one that looks most like the product.
const bestPicture = (pics) => pics.reduce((best, p) => (!best || p.score > best.score ? p : best), null)?.src || '';

// A product page: Amazon's /dp/ and /gp/product/, and the /products/, /ip/, /p/ and /itm/ of
// other stores.
const PRODUCT_PAGE = /\/(?:dp|gp\/product|gp\/aw\/d|products?|ip|p|itm)\/[\w-]{4,}/i;
// Words on a link or picture that aren't a product's name.
const NOT_NAME = /^(?:track|view|manage|buy|shop|write|rate|review|return|replace|see|order|details|your|more|click|learn|sign|change|cancel|leave|get|share|visit|image|photo|product|item|amazon(?:\.com)?)\b|^\W*$|\$\s?\d|@/i;

// The products an email names, in order, once each: the words of its links to product pages and
// of the pictures in them, and of Amazon's product pictures. Amazon's shipping emails name what's
// in the box only there.
export function itemsIn(doc) {
  const out = [];
  const add = (t) => {
    t = (t || '').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 240 || !/[a-z]{3}\S*\s+\S*[a-z]{2}/i.test(t) || NOT_NAME.test(t)) return;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const a of doc.querySelectorAll('a[href]')) {
    if (!PRODUCT_PAGE.test(unwrap(a.getAttribute('href') || ''))) continue;
    add(a.textContent);
    for (const img of a.querySelectorAll('img[alt]')) add(img.getAttribute('alt'));
  }
  for (const img of doc.querySelectorAll('img[alt]')) if (/\/images\/I\//.test(img.getAttribute('src') || '')) add(img.getAttribute('alt'));
  return out.slice(0, 8);
}

// One email with its HTML, as packages.js reads it. Its product pictures in order (pictures) let
// packages.js tell whose picture is whose when only some of the items are shipped.
export function fromHtml(m, html) {
  const { text, doc } = htmlText(html);
  const pics = productPictures(doc, m.subject);
  return {
    ...m,
    body: text.slice(0, BODY_CHARS),
    links: trackingLinks(doc),
    picture: bestPicture(pics),
    pictures: pics.slice(0, 20).map((p) => p.src),
    items: itemsIn(doc),
    full: true,
  };
}

// One Gmail account's shipping emails, through its own page.
async function readGmail(acct) {
  const hashPart = encodeURIComponent(gmailSearch(acct.where)).replace(/%20/g, '+');
  const msg = await readHidden(`https://mail.google.com/mail/u/${acct.index}/#search/${hashPart}`, {
    type: 'gmail-page',
    hosts: ['mail.google.com'],
    wait: 90e3,
    accept: (m) => m.base === `/mail/u/${acct.index}/`,
  });
  if (!msg) throw new Error('Gmail’s page didn’t load');
  // The accounts moved round since Daybook last looked: the next look sorts it out.
  if (msg.email && msg.email !== acct.email) throw new Error('Gmail accounts changed');
  const url = (t) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(acct.email)}#all/${t.hex}`;
  const out = [];
  for (const t of msg.threads || []) {
    const base = { subject: t.subject, from: t.from, fromAddr: t.fromAddr, at: t.at, url: url(t), snippet: t.snippet, unread: t.unread };
    if (!t.messages?.length) {
      // Only the search result: the subject and preview still say something.
      out.push({ ...base, msgId: t.lastId || t.hex });
      continue;
    }
    t.messages.forEach((m, i) => {
      const last = i === t.messages.length - 1;
      out.push(
        fromHtml(
          {
            ...base,
            // The newest email's id matches the unread feed's, so the two count once.
            msgId: last ? t.lastId || t.hex : `${t.hex}.${i}`,
            from: m.from || t.from,
            fromAddr: m.fromAddr || t.fromAddr,
            at: m.at || t.at || Date.now(),
            snippet: last ? t.snippet : '',
          },
          m.html,
        ),
      );
    });
  }
  return out;
}

// fn on each of list, `at` at a time, settled in list's order.
async function inTurn(list, at, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, list.length) }, worker));
  return out;
}

// The newest emails about orders and packages in the Outlook mailbox (folders: ids, or 'all'
// for the whole mailbox), then the ones that look like shipping news read in full.
async function readOutlook(clientId, folders) {
  // Stores send several emails an order, and digests (USPS Informed Delivery) one a day, so two
  // weeks of them run long: look through plenty, and read the newest 40 about packages in full.
  const q = `$search=${encodeURIComponent(`"${OUTLOOK_SEARCH}"`)}&$top=100&$select=id,subject,from,receivedDateTime,bodyPreview,webLink,isRead`;
  const paths = folders.includes('all') ? ['/me/messages'] : folders.slice(0, 8).map((id) => `/me/mailFolders/${encodeURIComponent(id)}/messages`);
  // A folder deleted since it was picked adds nothing, unless it's the only one.
  const lists = await Promise.all(paths.map((p) => graph(clientId, `${p}?${q}`).catch((err) => (paths.length === 1 ? Promise.reject(err) : { value: [] }))));
  const since = Date.now() - DAYS * 86400e3;
  const items = lists
    .flatMap((l) => l.value || [])
    .map((m) => ({
      msgId: m.id,
      subject: m.subject || '',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '',
      fromAddr: m.from?.emailAddress?.address || '',
      at: Date.parse(m.receivedDateTime) || Date.now(),
      url: m.webLink,
      snippet: m.bodyPreview || '',
      unread: !m.isRead,
    }))
    .filter((m) => m.at >= since && aboutPackage(m))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  // A few at a time: Outlook answers only about four requests at once for a mailbox, and an
  // email whose body doesn't come is read from its preview alone (no day, no items).
  const got = await inTurn(items, 3, (m) => graph(clientId, `/me/messages/${encodeURIComponent(m.msgId)}?$select=body`));
  return items.map((m, i) => {
    const body = got[i].status === 'fulfilled' ? got[i].value.body : null;
    if (!body?.content) return m;
    return fromHtml(m, body.contentType === 'text' ? `<pre>${body.content.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>` : body.content);
  });
}

// Shipping emails from the Gmail accounts signed into this browser ([{ index, email, where }],
// where is what to look in; see gmailWhere) and, when `outlook` (a Microsoft client ID) is given,
// the connected Outlook mailbox's outlookFolders. Kept for 20 minutes; one Daybook tab reads at
// a time and the others use what it found. A source that can't be read keeps what it had last
// time; one with nothing picked has nothing.
export function refreshShippingMail({ gmail = [], outlook = '', outlookFolders = ['all'] }, force, onData) {
  const accounts = gmail.filter((a) => gmailWhere(a.where) !== null).slice(0, MAX_ACCOUNTS);
  if (!outlookFolders.length) outlook = '';
  // v3: Outlook's bodies are read a few at a time, so more of them come.
  const sig = hash(['v3', accounts.map((a) => [a.email, gmailWhere(a.where)]), outlook && outlookFolders]);
  local.remove(['cache:pkg:gmail', 'pkg:thumbs']); // from when Gmail was read through its API
  return cached({
    key: KEY,
    sig,
    maxAge: 20 * 60e3,
    force,
    fetch: () =>
      navigator.locks.request('shipmail', async () => {
        const before = await local.get(`cache:${KEY}`);
        if (!force && before?.sig === sig && Date.now() - before.at < 15 * 60e3) return before.data;
        const old = before?.data || [];
        const kept = (source) => old.filter((m) => m.source === source);
        const out = [];
        const report = {};
        const note = (source, list, err) => (report[source] = err ? { error: String(err?.message || err) } : { found: list.length, full: list.filter((m) => m.full).length });
        if (accounts.length) {
          // Let the board draw first; Gmail's page is a big one.
          await sleep(force ? 0 : 3000);
          await allowFrames(RULE, ['mail.google.com']);
        }
        for (const acct of accounts) {
          const source = `gmail:${acct.email}`;
          try {
            const got = await readGmail(acct);
            note(source, got);
            out.push(...got.map((m) => ({ ...m, source })));
          } catch (err) {
            console.warn('[daybook] shipping emails, Gmail:', err);
            note(source, null, err);
            out.push(...kept(source));
          }
        }
        if (accounts.length) dropFrames(RULE);
        if (outlook) {
          try {
            const got = await readOutlook(outlook, outlookFolders);
            note('outlook', got);
            out.push(...got.map((m) => ({ ...m, source: 'outlook' })));
          } catch (err) {
            console.warn('[daybook] shipping emails, Outlook:', err);
            note('outlook', null, err);
            out.push(...kept('outlook'));
          }
        }
        await local.set(REPORT, { at: Date.now(), sources: report });
        return out.sort((a, b) => b.at - a.at);
      }),
    render: (data) => onData(data || []),
  });
}

// What the last search found in each account ({ at, sources: { 'gmail:address' or 'outlook':
// { found, full } or { error } } }), for Settings.
export const lastShippingReport = async () => (await local.get(REPORT)) || null;

// The shipping emails Daybook last read, for a look-up without reading again.
export const lastShippingMail = async () => (await local.get(`cache:${KEY}`))?.data || [];
