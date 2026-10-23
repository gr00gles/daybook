// Deliveries: shipping emails spotted among your mail, with a link to the carrier's tracking
// page when the email carries a tracking number. Everything is read from the subject and the
// preview text; nothing leaves your computer except the Gmail search below. For the Google
// account connected in Daybook, the product picture comes from the email itself.
import { $, esc, safeUrl, cached, relTime, startOfDay, addDays, local } from './util.js';
import { setTicker } from './ticker.js';
import { gmailApi } from './gauth.js';
import { icon } from './icons.js';
import { domainOf, logoUrl } from './companies-store.js';

const CARRIERS = {
  ups: { name: 'UPS', track: (n) => `https://www.ups.com/track?tracknum=${n}` },
  usps: { name: 'USPS', track: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  fedex: { name: 'FedEx', track: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  dhl: { name: 'DHL', track: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}` },
  amazon: { name: 'Amazon', track: (n) => `https://track.amazon.com/tracking/${n}` },
};

// Tracking numbers, most distinctive first. Plain-digit numbers only count next to words
// about tracking, and FedEx and DHL ones only when the email names the carrier.
const TRACKING_WORDS = /track|shipment|package|parcel|deliver/i;
const NUMBERS = [
  { carrier: 'ups', re: /\b1Z[0-9A-Z]{16}\b/ },
  { carrier: 'amazon', re: /\bTBA\d{12}\b/ },
  { carrier: 'usps', re: /\b[A-Z]{2}\d{9}US\b/ },
  { carrier: 'usps', re: /(?<![\d])9[2-5](?: ?\d){20}(?:(?: ?\d){4})?(?![\d])/, plain: true, needs: /usps|postal|informed delivery/i },
  { carrier: 'fedex', re: /(?<![\d-])(?:\d{12}|\d{15}|\d{20}|\d{22})(?![\d-])/, plain: true, needs: /fedex/i },
  { carrier: 'dhl', re: /(?<![\d-])\d{10}(?![\d-])/, plain: true, needs: /\bdhl\b/i },
];

const SENDERS = [
  ['amazon', /amazon/i],
  ['ups', /\bups\b/i],
  ['fedex', /fedex/i],
  ['usps', /\busps\b|postal service|informed delivery/i],
  ['dhl', /\bdhl\b/i],
];

const CARRIER_DOMAINS = new Set(['ups.com', 'usps.com', 'fedex.com', 'dhl.com', 'dhl.de', 'ontrac.com', 'lasership.com', 'narvar.com', 'aftership.com', 'route.com']);

const RANK = { out: 0, problem: 1, soon: 2, transit: 3, delivered: 4 };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = /(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i;
const NOT_DELIVERED = /\bbe delivered|not (?:been |yet )?delivered|undelivered|n[’']t (?:been |yet |be )?delivered|didn[’']t get delivered/i;
const BOUNCE_FROM = /mailer-daemon|mail delivery (?:subsystem|system)|postmaster/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliver(?:able|ed)|returned mail|message not delivered|delivery (?:has )?failed/i;

// What an email says about a package. Words like "today" and "Friday" are about the day the
// email was sent; `day` keeps that (0 = that day, 1 = the next, or a weekday or date).
function statusOf(text) {
  if (/delivery (?:attempt|exception)|attempted delivery|missed (?:your )?delivery|unable to deliver|undeliverable|delivery (?:has )?failed|could(?:n[’']?t| not) (?:be )?deliver|was(?:n[’']t| not) delivered|\bdelay(?:ed)?\b|held at|return(?:ed|ing) to sender|action required/i.test(text))
    return { state: 'problem' };
  if (/out for delivery|on the truck/i.test(text)) return { state: 'out', day: 0, label: 'Out for delivery' };
  if (/\bdelivered\b/i.test(text) && !NOT_DELIVERED.test(text)) return { state: 'delivered' };
  if (/arriv(?:ing|es) today|deliver(?:y|ed)?:? (?:by |on )?today|scheduled for delivery today/i.test(text)) return { state: 'out', day: 0 };
  if (/(?:arriving|arrives|deliver(?:y|ed)?):? (?:by |on )?tomorrow/i.test(text)) return { state: 'soon', day: 1 };
  const day = text.match(new RegExp(`(?:arriving|arrives|(?:expected|estimated|scheduled) delivery|expected)(?: on| by| date)?:?,? (${DAY.source})`, 'i'));
  if (day) return { state: 'transit', day: day[1] };
  if (/\bshipped\b|on (?:its|the) way|in transit|dispatched|label created|ready (?:to|for) ship|shipment|tracking (?:number|info)/i.test(text)) return { state: 'transit' };
  return null;
}

// The local midnight of the day a status points at, counted from the email's own date.
function dueDay(day, sent) {
  if (day == null) return null;
  const base = new Date(sent);
  base.setHours(0, 0, 0, 0);
  if (typeof day === 'number') return addDays(base.getTime(), day);
  const w = WEEKDAYS.indexOf(day.slice(0, 3).toLowerCase());
  if (/day$/i.test(day) && w >= 0) return addDays(base.getTime(), (w - base.getDay() + 7) % 7);
  const [mon, num] = day.replace('.', '').split(' ');
  const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (m < 0) return null;
  let t = new Date(base.getFullYear(), m, Number(num)).getTime();
  // "Jan 3" in a December email means next year.
  if (t < addDays(base.getTime(), -180)) t = new Date(base.getFullYear() + 1, m, Number(num)).getTime();
  return t;
}

// Status words alone also turn up in ads ("free delivery today"), so without a distinctive
// tracking number the subject has to talk about an order or package and not sound like an offer.
const ABOUT_ORDER = /\b(?:order|package|parcel|shipment|delivery|delivered|shipped|tracking|item)s?\b/i;
const PROMO = /\bfree\b|\bsale\b|% off|\bdeals?\b|\boffer\b|\bsave\b|coupon|shop now|subscribe/i;

function numberIn(text, context) {
  for (const { carrier, re, plain, needs } of NUMBERS) {
    if (needs && !needs.test(context)) continue;
    if (plain && !TRACKING_WORDS.test(context)) continue;
    const m = text.match(re);
    if (!m) continue;
    const n = m[0].replace(/ /g, '');
    if (carrier === 'usps' && plain && n.length !== 22 && n.length !== 26) continue;
    return { carrier, number: n, plain: Boolean(plain) };
  }
  return null;
}

function titleOf(subject, from) {
  const t = subject
    .replace(/^(?:fwd?|re):\s*/i, '')
    .replace(/^(?:shipped|delivered|out for delivery|arriving[^:]*|ordered|(?:\w+ )?update)\s*:\s*/i, '')
    .replace(/^(?:"([^"]+)"|“([^”]+)”|'([^']+)'(?=\s|$))/, (all, a, b, c) => a || b || c)
    .trim();
  // "Your package has been delivered" says less than who sent it.
  if (from && (!t || /^(?:your|a|an)\b.{0,30}\b(?:order|package|parcel|shipment|item|delivery)\b/i.test(t))) return from.slice(0, 70);
  return (t || 'Package').slice(0, 70);
}

// One mail item ({ subject, snippet, from, at, url }) → what it says about a package, or null.
function readMail(m) {
  if (!m) return null;
  const subject = m.subject || '';
  const from = m.from || '';
  // Bounced email, but not a carrier's own "undeliverable" notice about a package.
  if (BOUNCE_FROM.test(from) || (BOUNCE_SUBJECT.test(subject) && !SENDERS.some(([, re]) => re.test(from)))) return null;
  const context = `${from} ${subject} ${m.snippet || ''}`;
  const found = numberIn(`${subject} ${m.snippet || ''}`.toUpperCase(), context);
  const fromSubject = statusOf(subject);
  const fromSnippet = found || ABOUT_ORDER.test(subject) ? statusOf(m.snippet || '') : null;
  // "Shipped: …" with "Arriving Thursday" in the preview: the preview says more.
  const status =
    fromSubject?.state === 'transit' && fromSnippet && fromSnippet.state !== 'delivered' && (fromSnippet.state !== 'transit' || fromSnippet.day)
      ? fromSnippet
      : fromSubject || fromSnippet;
  const strong = found && !found.plain;
  if (!strong && (!(status || found) || !ABOUT_ORDER.test(`${subject} ${found ? m.snippet || '' : ''}`) || PROMO.test(subject))) return null;
  const sender = SENDERS.find(([, re]) => re.test(`${from} ${subject}`))?.[0] || '';
  const at = m.at || Date.now();
  const title = titleOf(subject, from);
  return {
    msgId: m.msgId || '',
    // Gmail API ids, for the emails Daybook may open (the connected Google account's).
    apiId: m.api && m.msgId ? m.msgId : '',
    domain: domainOf(m.fromAddr),
    from,
    fromAddr: m.fromAddr || '',
    carrier: found?.carrier || sender,
    number: found?.number || '',
    titleKey: `${sender || from.toLowerCase()}|${title.toLowerCase()}`,
    state: status?.state || 'transit',
    label: status?.label || '',
    tracking: !status,
    due: dueDay(status?.day, at),
    title,
    at,
    mailUrl: safeUrl(m.url),
  };
}

const shortDay = (t) => {
  const days = Math.round((t - startOfDay()) / 86400e3);
  return days < 7 ? new Date(t).toLocaleDateString(undefined, { weekday: 'short' }) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// How a package reads right now, or null once its news is stale.
function present(p, now = Date.now()) {
  const age = now - p.at;
  if (p.state === 'delivered') return age < 2 * 86400e3 ? { state: 'delivered', label: 'Delivered' } : null;
  if (p.state === 'problem') return age < 3 * 86400e3 ? { state: 'problem', label: 'Needs attention' } : null;
  if (p.due != null) {
    const days = Math.round((p.due - startOfDay(now)) / 86400e3);
    // The day has passed: it most likely came, and the delivered email went unseen.
    if (days < 0) return null;
    if (days === 0) return { state: 'out', label: p.label && startOfDay(p.at) === startOfDay(now) ? p.label : 'Arriving today' };
    if (days === 1) return { state: 'soon', label: 'Arriving tomorrow' };
    return { state: 'transit', label: `Arriving ${shortDay(p.due)}` };
  }
  return age < 7 * 86400e3 ? { state: 'transit', label: p.tracking ? 'Tracking' : 'On the way' } : null;
}

// One mail item → a delivery as it reads now, or null. Used to tag rows in the mail list.
export function deliveryOf(m) {
  const p = readMail(m);
  const now = p && present(p);
  return now ? { ...p, ...now } : null;
}

// The deliveries worth showing: the newest word on each package.
export function deliveriesFrom(items) {
  const seen = new Set();
  const all = [];
  for (const m of items) {
    // The same email can come from the unread feed and from the Gmail search.
    if (m.msgId && seen.has(m.msgId)) continue;
    if (m.msgId) seen.add(m.msgId);
    const p = readMail(m);
    if (p) all.push(p);
  }
  // Emails about one package don't all carry its tracking number: link them by sender and title.
  const alias = new Map();
  for (const p of all) if (p.number) alias.set(p.titleKey, p.number);
  const groups = new Map();
  for (const p of all) {
    const key = p.number || alias.get(p.titleKey) || p.titleKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.at - a.at);
    const newest = list[0];
    const now = present(newest);
    if (!now) continue;
    const withNumber = list.find((p) => p.number);
    // The store's emails say more about what's in the box than the carrier's do.
    const store = list.find((p) => p.domain && !CARRIER_DOMAINS.has(p.domain)) || list.find((p) => p.domain);
    out.push({
      ...newest,
      ...now,
      domain: store?.domain || '',
      apiIds: list.map((p) => p.apiId).filter(Boolean),
      carrier: withNumber?.carrier || newest.carrier,
      number: withNumber?.number || '',
      href: withNumber ? CARRIERS[withNumber.carrier].track(withNumber.number) : newest.mailUrl,
    });
  }
  return out.sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);
}

// ---- The Deliveries card ------------------------------------------------------------------

const DAY_MS = 86400e3;
// Days apart counted from midnight to midnight, so this evening is still today.
const daysFrom = (t) => Math.round((startOfDay(t) - startOfDay()) / DAY_MS);
const dateParts = (t) => ({
  day: daysFrom(t) === 0 ? 'Today' : daysFrom(t) === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString(undefined, { weekday: 'short' }),
  date: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
});

function thumb(d) {
  const pic = thumbs.get(d.apiIds?.find((id) => thumbs.get(id)) || '');
  if (pic) return `<span class="pkg-thumb photo"><img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  const logo = logoUrl(d.domain || (d.carrier && { ups: 'ups.com', usps: 'usps.com', fedex: 'fedex.com', dhl: 'dhl.com', amazon: 'amazon.com' }[d.carrier]));
  return logo
    ? `<span class="pkg-thumb logo"><img src="${esc(logo)}" alt="" width="32" height="32" referrerpolicy="no-referrer"></span>`
    : `<span class="pkg-thumb">${icon('box')}</span>`;
}

// Package rows, newest word first. Used by the Deliveries card and by the company pages.
export function deliveryRows(list, max = 6) {
  return `<ol class="pkg-list">${list
    .slice(0, max)
    .map((d) => {
      const who = CARRIERS[d.carrier]?.name || '';
      const when = d.state === 'delivered' ? dateParts(d.at) : d.due != null ? dateParts(d.due) : null;
      const tip = [d.title, d.number && `${who} ${d.number}`, `email ${relTime(d.at)}`].filter(Boolean).join(' · ');
      // Who sent it and the tracking number, without saying "UPS · UPS".
      const sender = d.from && d.from !== d.title && !(who && d.from.toLowerCase().includes(who.toLowerCase())) ? d.from : '';
      const meta = [sender, who && d.number ? `${who} ${d.number}` : sender ? '' : who].filter(Boolean).join(' · ');
      return `<li><a class="pkg s-${d.state}" href="${esc(d.href)}" title="${esc(tip)}">
        ${thumb(d)}
        <span class="pkg-text">
          <span class="pkg-status">${esc(d.label)}</span>
          <span class="pkg-title">${esc(d.title)}</span>
          ${meta ? `<span class="pkg-meta">${esc(meta)}</span>` : ''}
        </span>
        ${
          when
            ? `<span class="pkg-when" aria-label="${d.state === 'delivered' ? 'Delivered' : 'Estimated delivery'} ${esc(when.day)} ${esc(when.date)}"><span class="pkg-day">${esc(when.day)}</span><span class="pkg-date">${esc(when.date)}</span></span>`
            : ''
        }
      </a></li>`;
    })
    .join('')}</ol>${list.length > max ? `<p class="pkg-more">+${list.length - max} more</p>` : ''}`;
}

let shown = [];

export function initDeliveries() {
  loadThumbs().then(() => shown.length && paintCard());
}

// The newest deliveries from the mail card; repainted whenever the mail is.
export function renderDeliveries(list) {
  shown = list;
  paintCard();
  findPictures(list);
}

function paintCard() {
  const body = $('#deliveries-body');
  if (!body) return;
  const coming = shown.filter((d) => d.state !== 'delivered').length;
  $('#deliveries-count').textContent = coming ? String(coming) : '';
  $('#card-deliveries').classList.toggle('is-empty', !shown.length);
  body.innerHTML = shown.length ? deliveryRows(shown) : '<p class="quiet">Nothing on the way. Shipping emails show up here with their delivery dates.</p>';
  setTicker(
    'deliveries',
    shown.map((d) => {
      const when = d.state === 'delivered' ? null : d.due != null ? dateParts(d.due) : null;
      return { tag: d.label, title: d.title, meta: when ? `${when.day} ${when.date}` : '', href: d.href };
    }),
  );
}

// ---- Product pictures -------------------------------------------------------------------------
// The first picture in a shipping email that looks like the product: not a logo, a tracking
// pixel, a social button or a banner. Remembered per email so each one is opened once.

const THUMBS_KEY = 'pkg:thumbs';
const thumbs = new Map(); // Gmail message id -> picture URL, or '' when the email has none
const looking = new Set();
let thumbsLoaded;
let allowed = true; // false once Gmail says Daybook may not open emails

const loadThumbs = () =>
  (thumbsLoaded ||= local.get(THUMBS_KEY).then((saved) => {
    for (const [id, src] of Object.entries(saved || {})) thumbs.set(id, src);
  }));

async function findPictures(list) {
  await loadThumbs();
  let found = false;
  for (const d of allowed ? list : []) {
    const ids = d.apiIds || [];
    if (!ids.length || ids.some((id) => thumbs.get(id))) continue;
    // The newest two emails about it that haven't been looked at yet.
    for (const id of ids.filter((x) => !thumbs.has(x) && !looking.has(x)).slice(0, 2)) {
      looking.add(id);
      try {
        const src = pictureIn(await emailHtml(id), d.title);
        thumbs.set(id, src);
        if (src) {
          found = true;
          break;
        }
      } catch (err) {
        // No permission yet: don't ask again in this tab. Anything else: try again later.
        if (err.code === 'needs-google') allowed = false;
        else console.warn('[daybook] package picture:', err);
      } finally {
        looking.delete(id);
      }
    }
  }
  if (found) paintCard();
  // Keep the newest 80.
  local.set(THUMBS_KEY, Object.fromEntries([...thumbs].slice(-80)));
}

const b64 = (data) => new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function htmlParts(part, out = []) {
  if ((part.mimeType || '').toLowerCase() === 'text/html' && !part.filename) out.push(part);
  for (const p of part.parts || []) htmlParts(p, out);
  return out;
}

async function emailHtml(id) {
  const m = await gmailApi(`/messages/${encodeURIComponent(id)}?format=full`, { method: 'GET', quiet: true });
  const texts = await Promise.all(
    htmlParts(m.payload || {}).map(async (p) => {
      let data = p.body?.data;
      if (!data && p.body?.attachmentId) data = (await gmailApi(`/messages/${id}/attachments/${p.body.attachmentId}`, { method: 'GET', quiet: true })).data;
      return data ? b64(data) : '';
    }),
  );
  return texts.join('\n');
}

const NOT_PRODUCT = /logo|icon|pixel|spacer|blank|beacon|track|open\.|\/o\.gif|badge|social|facebook|twitter|instagram|pinterest|tiktok|youtube|linkedin|app[-_ ]?store|google[-_ ]?play|banner|header|footer|divider|rating|stars?\b|arrow|button|btn|signature|qr/i;

export function pictureIn(html, title = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html'); // parsing loads no pictures
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let best = null;
  for (const img of doc.querySelectorAll('img')) {
    const src = (img.getAttribute('src') || '').trim();
    if (!/^https:\/\//i.test(src)) continue;
    const alt = img.getAttribute('alt') || '';
    const w = parseInt(img.getAttribute('width') || img.style.width, 10) || 0;
    const h = parseInt(img.getAttribute('height') || img.style.height, 10) || 0;
    if (NOT_PRODUCT.test(`${src} ${alt} ${img.className}`)) continue;
    if ((w && w < 48) || (h && h < 48) || (w && h && (w / h > 2.2 || h / w > 2.2))) continue;
    let score = 0;
    if (/\/images\/I\//.test(src)) score += 5; // Amazon's product pictures
    if (alt && alt.toLowerCase().split(/[^a-z0-9]+/).some((x) => words.has(x))) score += 3;
    if (/product|item|catalog|sku|cdn\.shopify|scene7|\/is\/image\//i.test(src)) score += 2;
    if (w >= 64 && h >= 64) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { src, score };
  }
  return best?.src || '';
}

export const deliveryTag = (d) => (d ? `<span class="pkg-tag s-${d.state}">${icon('box')}${esc(d.label)}</span>` : '');

// Shipping emails from the last 10 days in the Gmail account connected under Google, read or
// not. Only runs once Daybook already has Gmail permission (from Mark as read or Delete);
// it never asks for it.
const SEARCH =
  'newer_than:10d -category:promotions {"out for delivery" "has shipped" "was delivered" "been delivered" "tracking number" "on its way" "in transit" "arriving" subject:shipped subject:delivered subject:shipment}';

export function refreshShippingMail(email, force, onData) {
  return cached({
    key: 'pkg:gmail',
    sig: email,
    maxAge: 15 * 60e3,
    force,
    fetch: async () => {
      let list;
      try {
        list = await gmailApi(`/messages?${new URLSearchParams({ q: SEARCH, maxResults: '15' })}`, { method: 'GET', quiet: true });
      } catch (err) {
        // No Gmail permission yet: the unread feed is all there is. Look again in a while.
        if (err.code === 'needs-google') return [];
        throw err;
      }
      const ids = (list.messages || []).map((m) => m.id);
      const got = await Promise.allSettled(
        ids.map((id) =>
          gmailApi(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&fields=id,threadId,snippet,internalDate,payload/headers`, {
            method: 'GET',
            quiet: true,
          }),
        ),
      );
      return got
        .filter((r) => r.status === 'fulfilled')
        .map(({ value: m }) => {
          const header = (name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
          return {
            msgId: m.id,
            subject: header('subject'),
            from: header('from').replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, ''),
            fromAddr: header('from').match(/<([^>]+)>\s*$/)?.[1] || header('from').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] || '',
            api: true,
            snippet: decodeEntities(m.snippet || ''),
            at: Number(m.internalDate) || Date.now(),
            url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${m.threadId}`,
          };
        })
        // Keep only what is about a package; the search also matches other mail.
        .filter((m) => readMail(m));
    },
    render: (data) => onData(data || []),
  });
}

// Gmail's snippets come HTML-escaped.
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
  });
}
