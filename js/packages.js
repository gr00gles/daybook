// Deliveries: the packages your shipping emails talk about, with a link to the carrier's
// tracking page when an email carries a tracking number. Shipping emails come read in full from
// shipmail.js (Gmail through its own page, Outlook through its sign-in), and unread ones also
// come from the mail card as a subject and a preview. Nothing leaves your computer. Packages
// with a tracking number, and the ones added by hand in Settings, get their status and
// delivery day from the carrier's own tracking page (tracking.js) instead.
import { $, esc, safeUrl, relTime, startOfDay, addDays, local } from './util.js';
import { setTicker } from './ticker.js';
import { loadTracking, refreshTracking, onTracking, trackedState, carrierOf, dateIn, PAGES } from './tracking.js';
import { lastShippingMail } from './shipmail.js';
import { loadAmazonOrders, refreshAmazonOrders, onAmazonOrders, isAmazonOrder, invoiceUrl } from './amazon.js';
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
// Most pressing first; among packages on their way, the soonest due, then the newest news.
const byUrgency = (a, b) => RANK[a.state] - RANK[b.state] || (a.due ?? Infinity) - (b.due ?? Infinity) || b.at - a.at;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = /(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i;
const WEEKDAY = /\b(?:(sun|mon|tues|wednes|thurs|fri|satur)day|(sun|mon|tue|wed|thu|fri|sat)\b\.?)/i;
const NOT_DELIVERED = /\bbe delivered|not (?:been |yet )?delivered|undelivered|n[’']t (?:been |yet |be )?delivered|didn[’']t get delivered/i;
const BOUNCE_FROM = /mailer-daemon|mail delivery (?:subsystem|system)|postmaster/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliver(?:able|ed)|returned mail|message not delivered|delivery (?:has )?failed/i;

// What an email says about a package. Words like "today" and "Friday" are about the day the
// email was sent; `day` keeps that (0 = that day, 1 = the next, or a weekday or date).
function statusOf(text) {
  if (/delivery (?:attempt|exception)|attempted delivery|missed (?:your )?delivery|unable to deliver|undeliverable|delivery (?:has )?failed|could(?:n[’']?t| not) (?:be )?deliver|was(?:n[’']t| not) delivered|\bdelay(?:ed)?\b|held at|return(?:ed|ing) to sender|action required/i.test(text))
    return { state: 'problem' };
  if (/out for delivery|on the truck/i.test(text)) return { state: 'out', day: 0, label: 'Out for delivery' };
  if ((/\bdelivered\b/i.test(text) && !NOT_DELIVERED.test(text)) || /\b(?:has|have|it[’']s|is) arrived\b/i.test(text)) return { state: 'delivered' };
  if (/arriv(?:ing|es) today|deliver(?:y|ed)?:? (?:by |on )?today|scheduled for delivery today/i.test(text)) return { state: 'out', day: 0 };
  if (/(?:arriving|arrives|deliver(?:y|ed)?):? (?:by |on )?tomorrow/i.test(text)) return { state: 'soon', day: 1 };
  const day = text.match(new RegExp(`(?:arriving|arrives|(?:expected|estimated|scheduled) delivery|expected)(?: on| by| date)?:?,? (${DAY.source})`, 'i'));
  if (day) return { state: 'transit', day: day[1] };
  if (/\bshipped\b|on (?:its|the) way|in transit|dispatched|label created|ready (?:to|for) ship|shipment|tracking (?:number|info)/i.test(text)) return { state: 'transit' };
  return null;
}

// The same, from the top of an email's text, where stores put their headline ("Your package
// has shipped"). Only plain statements count: the rest of an email is full of words like
// "shipping" and "delivery" that say nothing about this package.
function bodyStatus(text) {
  if (/delivery (?:attempt|exception)|attempted delivery|missed (?:your )?delivery|unable to deliver|return(?:ed|ing) to sender/i.test(text)) return { state: 'problem' };
  if (/out for delivery|on the truck/i.test(text)) return { state: 'out', day: 0, label: 'Out for delivery' };
  if (/\b(?:was|were|been|successfully) delivered\b|\b(?:has|have) arrived\b/i.test(text) && !/not (?:been |yet )?delivered|n[’']t (?:been |yet )?delivered/i.test(text)) return { state: 'delivered' };
  if (/\b(?:has|have|was|were) (?:been )?shipped\b|\b(?:is|are) on (?:its|their|the) way\b|\bin transit\b/i.test(text)) return { state: 'transit' };
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

// The day a bit of text names, counted from the day the email was sent: a date, "today",
// "tomorrow" or a weekday.
function dayIn(text, sent) {
  if (!text || text.length > 120) return null;
  const t = dateIn(text, sent);
  if (t != null) return t;
  const w = text.match(WEEKDAY);
  if (!w) return null;
  const base = new Date(sent);
  base.setHours(0, 0, 0, 0);
  return addDays(base.getTime(), (WEEKDAYS.indexOf((w[1] || w[2]).slice(0, 3).toLowerCase()) - base.getDay() + 7) % 7);
}

// The day an email says the package is due: the first date after a label like "Estimated
// delivery", "Arriving" or "ETA", on the same line or the two after it. Other dates in an
// email (when it was ordered, a sale ending) aren't about the delivery.
const ETA = /\b(?:(?:estimated|expected|scheduled|anticipated|projected|new|updated|guaranteed)\s+(?:delivery|arrival)|eta\b|arriving|arrives|arrival date|delivery (?:date|by|on|window|estimate)|deliver(?:s|ed)? (?:by|on)|get it (?:by|on)|will arrive|should arrive)/i;
function etaIn(body, sent) {
  const lines = body.split('\n');
  for (let i = 0; i < Math.min(lines.length, 400); i++) {
    const m = lines[i].match(ETA);
    if (!m) continue;
    for (const part of [lines[i].slice(m.index + m[0].length), lines[i + 1], lines[i + 2]]) {
      const t = dayIn(part, sent);
      if (t != null) return t;
    }
  }
  return null;
}

// Status steps drawn as a progress bar ("Ordered · Shipped · Out for delivery · Delivered")
// are on every email a store sends about an order; they aren't news.
const STEP = /^(?:\[?(?:completed|pending|current)\]?\s*)?(?:ordered|order placed|placed|confirmed|processing|preparing|packed|shipped|in transit|on the way|out for delivery|delivered|label created)$/i;
const STEPS = /\bordered\b.{0,40}?\bshipped\b.{0,40}?\bout for delivery\b.{0,40}?\bdelivered\b/gi;
const leadOf = (body) => body.split('\n').filter((l) => !STEP.test(l)).join(' ').replace(STEPS, ' ').slice(0, 600);

// Status words alone also turn up in ads ("free delivery today"), so without a distinctive
// tracking number the subject has to talk about an order or package and not sound like an offer.
const ABOUT_ORDER = /\b(?:order(?:ed)?|package|parcel|shipment|delivery|delivered|shipped|tracking|item|arrived)s?\b/i;
const PROMO = /\bfree\b|\bsale\b|% off|\bdeals?\b|\boffer\b|\bsave\b|coupon|shop now|subscribe/i;

function numberIn(text, context, { plain: plainOk = true } = {}) {
  for (const { carrier, re, plain, needs } of NUMBERS) {
    if (plain && !plainOk) continue;
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

// What follows each "Tracking number:" in an email: the only place a number made of plain
// digits is taken to be a tracking number, since emails are full of order and item numbers.
const labeled = (body) => [...body.matchAll(/track(?:ing)?(?:\s*(?:number|no\.?|#|id|code))?\s*[:#]?/gi)].map((m) => body.slice(m.index, m.index + 80)).join('\n');

// A tracking number in a link to a carrier's (or a store's) tracking page.
const LINK_NUMBER = /(?:tracknum(?:bers?)?|trknbrs?|tlabels|tracking[-_]?(?:id|numbers?|nums?|no)|trackingnumbers?)=([0-9a-z]{8,40})/i;
function numberInLinks(links = []) {
  for (const href of links) {
    const n = (href.match(LINK_NUMBER)?.[1] || href.match(/\/tracking\/(TBA\d{12})\b/i)?.[1] || '').toUpperCase();
    if (!n) continue;
    const site = ['ups', 'usps', 'fedex', 'dhl', 'amazon'].find((c) => new RegExp(`\\b${c}\\.`, 'i').test(href)) || '';
    const carrier = carrierOf(n, site);
    if (carrier) return { carrier, number: n, plain: false };
  }
  return null;
}

// A forwarded email's own sender, date, subject and text, from the header its text starts with
// ("From: … Sent: … Subject: …"); the innermost one when it was forwarded more than once.
function forwarded(body) {
  const lines = body.split('\n');
  // "From:" on a line of its own, its value on the next.
  for (let i = Math.min(lines.length, 120) - 2; i >= 0; i--) if (/^(?:from|sent|date|to|cc|subject):$/i.test(lines[i])) lines.splice(i, 2, `${lines[i]} ${lines[i + 1]}`);
  let found = null;
  for (let i = 0; i < Math.min(lines.length, 120); i++) {
    const from = lines[i].match(/^from:\s*(.+)$/i);
    if (!from) continue;
    const near = lines.slice(i + 1, i + 7);
    const s = near.findIndex((l) => /^subject:/i.test(l));
    if (s < 0) continue;
    const date = near.slice(0, s).find((l) => /^(?:sent|date):/i.test(l)) || '';
    const addr = from[1].match(/<([^>\s]+@[^>\s]+)>/)?.[1] || from[1].match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] || '';
    found = {
      from: from[1].replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '') || addr,
      fromAddr: addr,
      at: Date.parse(date.replace(/^(?:sent|date):\s*/i, '').replace(/\s*\(.*$/, '').replace(/\s+at\s+/i, ' ')) || 0,
      subject: near[s].replace(/^subject:\s*/i, '').trim(),
      body: lines.slice(i + 2 + s).join('\n'),
    };
    i += s + 1;
  }
  return found;
}

// "Order #: WK12345678", "Order # 112-1234567-1234567": a number, not the next word.
const ORDER = /\border\s*(?:#|number|no\.?|id)\s*:?\s*#?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{4,30})/i;

// What's in the box: in a store's email, the line above each "Qty", "SKU" or "Item #", once each.
const ITEM_NEXT = /^(?:qty|quantity|sku|item\s*(?:#|no\.?|number)|model\s*(?:#|no\.?|number)|unit price)\b/i;
const NOT_ITEM = /^(?:order|ship|deliver|track|status|total|subtotal|tax|arriv|qty|quantity|sku|item\s*#|model|price|view|manage|return|sold by|size|colou?r)\b|\$\s?\d|@/i;
const isItem = (l) => l.length >= 12 && l.length <= 200 && /[a-z]{3}\S*\s+\S*[a-z]{3}/i.test(l) && !NOT_ITEM.test(l) && !STEP.test(l);
function itemsInText(body) {
  const lines = body.split('\n');
  const out = [];
  lines.forEach((l, at) => {
    if (!at || !ITEM_NEXT.test(l)) return;
    const item = lines.slice(Math.max(0, at - 3), at).reverse().find(isItem);
    if (item && !out.includes(item)) out.push(item);
  });
  return out.slice(0, 8);
}

const short = (s, n = 70) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

// Who sent a package, in a carrier's notice about it ("Shipped from: Acme").
const shipperIn = (body) => body.match(/^(?:shipped from|ship from|shipper|sender|from shipper)\s*:?\s*(\S.{1,60})$/im)?.[1] || '';

// The products an email names (items, from its product links and pictures) as one title: the
// first, and how many more.
function itemsText(items = []) {
  if (!items.length) return '';
  return items.length === 1 ? items[0] : `${short(items[0], 52)} and ${items.length - 1} more`;
}

// Subjects that only say something happened to "your order", or when it's due.
const GENERIC = /\b(?:your|the|an?) (?:[\w’'.]+ ){0,2}(?:order|package|parcel|shipment|item|delivery|purchase)s?\b|^(?:is |has |was |has been )?(?:shipped|delivered|out for delivery|on (?:its|the) way|arriving|arrived|order)\b|^\d+ items?\b|^it[’']s time\b|^(?:let us know|how did we do|how was|rate|review|tell us|thank(?:s| you))\b|^(?:usps|ups|fedex|dhl)?\W*(?:expected|scheduled|estimated) delivery\b|^(?:now )?arriving\b|^\W*$/i;

function titleOf(subject, from, item) {
  const t = subject
    .replace(/^(?:(?:fwd?|fw|re):\s*)+/i, '')
    .replace(/^order\s*#?\s*[\w-]*\d[\w-]*\s*/i, '')
    .replace(/^(?:shipped|delivered|out for delivery|arriving[^:]*|ordered|(?:\w+ )?update)\s*:\s*/i, '')
    // "Ordered 1 item: …", "Shipped 2 items: …"
    .replace(/^(?:(?:ordered|shipped|delivered)\s+)?\d+\s+items?\s*:\s*/i, '')
    .replace(/^(?:"([^"]+)"|“([^”]+)”|'([^']+)'(?=\s|$))/, (all, a, b, c) => a || b || c)
    .trim();
  // "Your package has been delivered" says less than what's in it, or who sent it.
  if (!t || GENERIC.test(t)) return short(item || (SENDERS.some(([, re]) => re.test(from)) && from.length < 30 ? `${from} package` : from) || t || 'Package');
  return short(t);
}

// One mail item ({ subject, snippet, from, at, url }, and for one read in full also body,
// links and picture) → what it says about a package, or null.
function readMail(m) {
  if (!m) return null;
  let { subject = '', from = '', fromAddr = '', body = '' } = m;
  let at = m.at || Date.now();
  // Forwarded: read the email inside, from whoever first sent it.
  const fw = /^(?:fwd?|fw)\s*:/i.test(subject);
  const fwd = fw && body ? forwarded(body) : null;
  if (fwd) ({ subject, from, fromAddr, body, at } = { ...fwd, at: fwd.at || at });
  // Only the preview: it starts "From: Acme <orders@acme.com> Sent: …".
  // A note typed above the forwarded email comes first ("FYI From: …").
  const fwdFrom = fw && !body && (m.snippet || '').slice(0, 300).match(/(?:^|\s)from:\s*([^<]*?)\s*<([^>\s]+@[^>\s]+)>/i);
  if (fwdFrom) ({ subject, from, fromAddr } = { subject: subject.replace(/^(?:(?:fwd?|fw)\s*:\s*)+/i, ''), from: fwdFrom[1] || fwdFrom[2], fromAddr: fwdFrom[2] });
  // Bounced email, but not a carrier's own "undeliverable" notice about a package.
  if (BOUNCE_FROM.test(from) || (BOUNCE_SUBJECT.test(subject) && !SENDERS.some(([, re]) => re.test(from)))) return null;
  const lead = body ? leadOf(body) : (m.snippet || '').replace(STEPS, ' ');
  const context = `${from} ${subject} ${lead}`;
  const upTop = numberIn(`${subject} ${lead}`.toUpperCase(), context);
  const found =
    upTop || (body ? numberIn(body.toUpperCase(), `${context} ${body}`, { plain: false }) || numberIn(labeled(body).toUpperCase(), `${context} ${body}`) || numberInLinks(m.links) : null);
  const about = ABOUT_ORDER.test(subject);
  const fromSubject = statusOf(subject);
  const fromLead = found || about ? (body ? bodyStatus(lead) : statusOf(lead)) : null;
  // "Shipped: …" with "Arriving Thursday" in the preview: the preview says more.
  let status =
    fromSubject?.state === 'transit' && fromLead && fromLead.state !== 'delivered' && (fromLead.state !== 'transit' || fromLead.day)
      ? fromLead
      : fromSubject || fromLead;
  const coming = !status || status.state === 'transit' || status.state === 'soon';
  const eta = body && coming && status?.day == null ? etaIn(body, at) : null;
  if (!status && eta != null && (found || about)) status = { state: 'transit' };
  // A distinctive number deep in an ad doesn't make it a shipping email.
  const strong = found && !found.plain && (upTop || !PROMO.test(subject));
  if (!strong && (!(status || found) || !ABOUT_ORDER.test(`${subject} ${found ? lead : ''}`) || PROMO.test(subject))) return null;
  const sender = SENDERS.find(([, re]) => re.test(`${from} ${subject}`))?.[0] || '';
  const items = m.items?.length ? m.items : body ? itemsInText(body) : [];
  // "1 item: Pants": how many are in this box, of everything in the order.
  const count = Number(`${subject}\n${body || m.snippet || ''}`.match(/\b(\d{1,2})\s+items?\s*:/i)?.[1]) || 0;
  const title = titleOf(subject, from, itemsText(items) || (body ? shipperIn(body) : ''));
  const order = `${subject}\n${body.slice(0, 4000)}`.match(ORDER)?.[1]?.toUpperCase() || '';
  return {
    msgId: m.msgId || m.id || '',
    domain: domainOf(fromAddr),
    from,
    fromAddr,
    carrier: found?.carrier || sender,
    number: found?.number || '',
    titleKey: `${sender || from.toLowerCase()}|${title.toLowerCase()}`,
    order,
    orderKey: order ? `${domainOf(fromAddr) || from.toLowerCase()}|${order}` : '',
    state: status?.state || 'transit',
    label: status?.label || '',
    tracking: !status,
    due: status?.day != null ? dueDay(status.day, at) : eta,
    title,
    items,
    count,
    at,
    picture: m.picture || '',
    full: Boolean(m.full),
    mailUrl: safeUrl(m.url),
  };
}

// Whether an email's subject and preview look like news about an order or a package, before
// it's read in full.
export const aboutPackage = (m) =>
  !PROMO.test(m.subject || '') && (/\b(?:order(?:ed)?|ship(?:ped|ping|ment)?|deliver(?:y|ed)?|track(?:ing)?|arriv(?:ing|ed|es)|package|parcel)\b/i.test(m.subject || '') || Boolean(readMail(m)));

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
    // The same email can come from the unread feed and read in full; the first one counts.
    const id = m.msgId || m.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const p = readMail(m);
    if (p) all.push(p);
  }
  // Emails about one package don't all carry its tracking number: link them by order number,
  // and by sender and title.
  const numberOf = new Map();
  const orderOf = new Map();
  for (const p of all) {
    if (p.orderKey) orderOf.set(p.titleKey, p.orderKey);
    if (p.number) {
      numberOf.set(p.titleKey, p.number);
      if (p.orderKey) numberOf.set(p.orderKey, p.number);
    }
  }
  const groups = new Map();
  for (const p of all) {
    const order = p.orderKey || orderOf.get(p.titleKey) || '';
    const key = p.number || (order && numberOf.get(order)) || numberOf.get(p.titleKey) || order || p.titleKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.at - a.at);
    const newest = list[0];
    // News without a day ("Shipment update") keeps the day an earlier email gave.
    const coming = newest.state === 'transit' || newest.state === 'soon';
    const due = newest.due ?? (coming ? list.find((p) => p.due != null)?.due ?? null : null);
    const now = present({ ...newest, due });
    if (!now) continue;
    const withNumber = list.find((p) => p.number);
    // The store's emails say more about what's in the box than the carrier's do.
    const store = list.find((p) => p.domain && !CARRIER_DOMAINS.has(p.domain)) || list.find((p) => p.domain);
    out.push({
      ...newest,
      ...now,
      due,
      title: (list.find((p) => p.full) || newest).title,
      items: list.find((p) => p.items?.length)?.items || [],
      order: list.find((p) => p.order)?.order || '',
      count: list.find((p) => p.count)?.count || 0,
      picture: list.find((p) => p.picture)?.picture || '',
      domain: store?.domain || '',
      carrier: withNumber?.carrier || newest.carrier,
      number: withNumber?.number || '',
      href: withNumber ? CARRIERS[withNumber.carrier].track(withNumber.number) : newest.mailUrl,
    });
  }
  return out.sort(byUrgency);
}

// ---- The Deliveries card ------------------------------------------------------------------

const DAY_MS = 86400e3;
// Days apart counted from midnight to midnight, so this evening is still today.
const daysFrom = (t) => Math.round((startOfDay(t) - startOfDay()) / DAY_MS);
const dateParts = (t) => ({
  day: daysFrom(t) === 0 ? 'Today' : daysFrom(t) === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString(undefined, { weekday: 'short' }),
  date: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
});

// A box with pictures of several things in it shows each in turn (see cycleThumbs).
function thumb(d) {
  const pics = (d.images || []).filter(Boolean);
  if (pics.length > 1) {
    cycleThumbs();
    return `<span class="pkg-thumb photo cycle">${pics
      .map((src, i) => `<img${i ? '' : ' class="on"'} src="${esc(safeUrl(src))}" alt="" loading="lazy" referrerpolicy="no-referrer">`)
      .join('')}</span>`;
  }
  if (d.picture) return `<span class="pkg-thumb photo"><img src="${esc(d.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  const logo = logoUrl(d.domain || (d.carrier && { ups: 'ups.com', usps: 'usps.com', fedex: 'fedex.com', dhl: 'dhl.com', amazon: 'amazon.com' }[d.carrier]));
  return logo
    ? `<span class="pkg-thumb logo"><img src="${esc(logo)}" alt="" width="32" height="32" referrerpolicy="no-referrer"></span>`
    : `<span class="pkg-thumb">${icon('box')}</span>`;
}

// Every few seconds, each box with several pictures shows its next one; still for those who'd
// rather have less motion, and while the page isn't in view.
let cycling = 0;
function cycleThumbs() {
  if (cycling || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  cycling = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    for (const box of document.querySelectorAll('.pkg-thumb.cycle')) {
      const pics = [...box.children];
      const at = pics.findIndex((p) => p.classList.contains('on'));
      pics[at]?.classList.remove('on');
      pics[(at + 1) % pics.length].classList.add('on');
    }
  }, 3000);
}

// A name cut to its first n words.
const words = (s, n = 9) => {
  const w = s.split(/\s+/);
  return w.length <= n ? s : `${w.slice(0, n).join(' ').replace(/[\s,;:|–—-]+$/, '')}…`;
};

// Package rows, newest word first. Used by the Deliveries card and by the company pages.
export function deliveryRows(list, max = 6) {
  return `<ol class="pkg-list">${list
    .slice(0, max)
    .map((d) => {
      const who = CARRIERS[d.carrier]?.name || '';
      const when = d.state === 'delivered' ? { day: 'Delivered', date: dateParts(d.at).date } : d.due != null ? dateParts(d.due) : null;
      // The day on the right says when; "Arriving Tue" or "Delivered" on the left would say it twice.
      const status = when && (d.state === 'delivered' || /^arriving\b/i.test(d.label)) ? '' : d.label;
      const tip = [d.items?.length ? d.items.map((i) => words(i)).join(' · ') : d.title, d.number && `${who} ${d.number}`, `email ${relTime(d.at)}`].filter(Boolean).join(' · ');
      // Who sent it and the tracking number, without saying "UPS · UPS".
      const sender = d.from && d.from !== d.title && !(who && d.from.toLowerCase().includes(who.toLowerCase())) ? d.from : '';
      // From the carrier's page: its latest word on the package, and where.
      const meta = d.event?.text
        ? [who, d.event.text, d.event.place].filter(Boolean).join(' · ')
        : [sender, who && d.number ? `${who} ${d.number}` : sender ? '' : who].filter(Boolean).join(' · ');
      return `<li><a class="pkg s-${d.state}" href="${esc(d.href)}" title="${esc(tip)}">
        ${thumb(d)}
        <span class="pkg-text">
          <span class="pkg-line">${status ? `<span class="pkg-status">${esc(status)}</span>` : ''}<span class="pkg-title">${esc(d.title)}</span></span>
          ${meta ? `<span class="pkg-meta">${esc(meta)}</span>` : ''}
        </span>
        ${
          when
            ? `<span class="pkg-when" aria-label="${d.state === 'delivered' ? `Delivered ${esc(when.date)}` : `Estimated delivery ${esc(when.day)} ${esc(when.date)}`}"><span class="pkg-day">${esc(when.day)}</span><span class="pkg-date">${esc(when.date)}</span></span>`
            : ''
        }
      </a></li>`;
    })
    .join('')}</ol>${list.length > max ? `<p class="pkg-more">+${list.length - max} more</p>` : ''}`;
}

// The Deliveries page (deliveries.html): a tile a box. On top, when (a pill in its state's colour),
// links to follow it and to its email, and who sent it and how it's coming; then each thing in it
// with its picture, each a link of its own: an Amazon product's page, or else the package's.
export function deliveryTiles(list) {
  return `<ol class="dt-list">${list
    .map((d) => {
      const who = CARRIERS[d.carrier]?.name || '';
      const when =
        d.state === 'delivered' ? `Delivered ${dateParts(d.at).date}` : d.due != null ? `${dateParts(d.due).day}, ${dateParts(d.due).date}` : d.label;
      const how = [d.from, d.number ? `${who} ${d.number}` : who && !(d.from || '').toLowerCase().includes(who.toLowerCase()) ? who : ''].filter(Boolean).join(' · ');
      const news = d.event?.text ? [d.event.text, d.event.place].filter(Boolean).join(' · ') : '';
      const links = [
        d.number && CARRIERS[d.carrier] && `<a href="${esc(CARRIERS[d.carrier].track(d.number))}">${icon('box')}Track</a>`,
        d.invoice && `<a href="${esc(d.invoice)}">${icon('money')}Invoice</a>`,
        d.mailUrl && d.mailUrl !== '#' && `<a href="${esc(d.mailUrl)}">${icon('mail')}Email</a>`,
      ].filter(Boolean);
      const names = d.items?.length ? d.items : [d.title];
      const items = names.map((name, i) => {
        const src = d.images?.[i] || (names.length === 1 ? d.picture : '');
        // Amazon's names lead with the brand.
        const brand = d.images?.length ? brandOf(name) : '';
        const rest = brand && name.startsWith(brand) ? name.slice(brand.length).trim() : '';
        const text = rest ? `<strong>${esc(brand)}</strong> ${esc(words(rest, 9 - brand.split(' ').length))}` : esc(words(name));
        const pic = src ? `<img src="${esc(safeUrl(src))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="dt-nopic">${icon('box')}</span>`;
        return `<li><a class="dt-item" href="${esc(safeUrl(d.links?.[i] || d.href))}" title="${esc(name)}">${pic}<span class="dt-name">${text}</span></a></li>`;
      });
      return `<li class="dt s-${d.state}">
        <div class="dt-head"><span class="dt-when">${esc(when)}</span>${links.length ? `<span class="dt-links">${links.join('')}</span>` : ''}</div>
        ${how ? `<p class="dt-how">${esc(how)}</p>` : ''}
        ${news ? `<p class="dt-news">${esc(news)}</p>` : ''}
        <ul class="dt-items">${items.join('')}</ul>
      </li>`;
    })
    .join('')}</ol>`;
}

let shown = [];
let settingsRef = null;
let fromMail = []; // the deliveries the mail card found, last time it drew
let live = {}; // what each package's carrier page (or newest email) last said, by tracking number
let amazon = {}; // what's in each Amazon order, from its page on amazon.com (amazon.js)
let trackTimer;
let amazonTimer;

// The new tab passes its settings; the Companies page uses the email side only.
export function initDeliveries(S) {
  if (!S) return;
  settingsRef = S;
  const reload = async () => {
    [live, amazon] = await Promise.all([loadTracking(), loadAmazonOrders()]);
    compose();
  };
  reload();
  onTracking(reload);
  onAmazonOrders(reload);
}

// The newest deliveries from the mail card; repainted whenever the mail is.
export function renderDeliveries(list) {
  fromMail = list;
  if (settingsRef) compose();
  else {
    shown = list;
    paintCard();
  }
}

// An email's package, with what its carrier's page says in place of what the email said.
function withLive(d) {
  // What stood in for an unreadable page was an email, and the emails already made this row.
  const t = d.number && live[d.number]?.from !== 'mail' && trackedState(live[d.number]);
  if (!t) return d;
  const at = t.event?.at || d.at;
  if (t.state === 'delivered' && Date.now() - at > 2 * DAY_MS) return null;
  // A page that says it's on its way without a day keeps the day the email gave.
  if (t.due == null && d.due != null && (t.state === 'transit' || t.state === 'soon')) return { ...d, event: t.event, at };
  return { ...d, state: t.state, label: t.label, due: t.due, event: t.event, at };
}

// A package added in Settings, as the card shows it.
function added(p) {
  const raw = live[p.number];
  const t = trackedState(raw);
  const carrier = carrierOf(p.number, raw?.carrier);
  const at = t?.event?.at || p.added || Date.now();
  if (t?.state === 'delivered' && Date.now() - at > 2 * DAY_MS) return null;
  return {
    title: p.name || `${CARRIERS[carrier]?.name || 'Package'} ${p.number}`,
    number: p.number,
    carrier,
    href: CARRIERS[carrier] ? CARRIERS[carrier].track(p.number) : `https://t.17track.net/en#nums=${encodeURIComponent(p.number)}`,
    domain: '',
    from: '',
    at,
    state: t?.state || 'transit',
    label: t?.label || (raw?.error ? 'Can’t read the status' : settingsRef.packages.checkSites !== false && PAGES[carrier] ? 'Checking…' : 'Tracking'),
    due: t?.due ?? null,
    event: t?.event || (raw?.error ? { text: raw.error } : null),
  };
}

// The card's list: the email packages (unless that's off) and the ones added by hand, with
// their carriers' news on each. A few seconds after the page settles, the packages still on
// their way get a fresh look (tracking.js decides which are due).
// The brand an Amazon product's name starts with: "Wrangler Authentics Men's Comfort Flex…" is
// Wrangler. A short first word ("Mr.", "LG") takes the next one along when it's a name too.
function brandOf(name) {
  const [a = '', b = ''] = name.replace(/[,|(].*$/, '').split(/\s+/);
  return (a.length <= 3 || a.endsWith('.')) && /^[A-Z][a-z]/.test(b) ? `${a} ${b}` : a;
}

// An Amazon package with what its order page says is in it, in place of the emails' category:
// its brands as the title, the full names (items) and pictures (images) for the Deliveries page,
// and the first picture as its own. An order can come in several boxes: the emails say how many
// items are in this one.
function withItems(d) {
  const got = settingsRef.packages.amazonPages !== false && amazon[d.order];
  if (!got?.items?.length) return d;
  const n = d.count || got.items.length;
  const names = got.items.slice(0, n);
  const images = (got.images || []).slice(0, n);
  const links = (got.links || []).slice(0, n);
  const brands = [...new Set(names.map(brandOf))];
  // Brands are short: up to two by name ("Attwood, Mr. Heater"), the rest counted.
  const title =
    brands.length === 1 ? (names.length > 1 ? `${brands[0]}, ${names.length} items` : brands[0]) : `${brands.slice(0, 2).join(', ')}${brands.length > 2 ? ` and ${brands.length - 2} more` : ''}`;
  return { ...d, items: names, images, links, title, picture: images.find(Boolean) || d.picture };
}

function compose() {
  const P = settingsRef.packages;
  const mail = P.fromMail === false ? [] : fromMail;
  // An Amazon package opens its order's invoice.
  const withInvoice = (d) => (isAmazonOrder(d.order) ? { ...d, invoice: invoiceUrl(d.order), href: invoiceUrl(d.order) } : d);
  const list = mail.map(withLive).filter(Boolean).map(withItems).map(withInvoice);
  for (const p of P.tracked || []) {
    // A package added by hand that was delivered days ago drops off (added() gives null).
    const d = !list.some((x) => x.number === p.number) && added(p);
    if (d) list.push(d);
  }
  shown = list.sort(byUrgency);
  paintCard();
  const orders = P.amazonPages === false ? [] : mail.filter((d) => isAmazonOrder(d.order)).map((d) => d.order);
  clearTimeout(amazonTimer);
  if (orders.length) amazonTimer = setTimeout(() => refreshAmazonOrders(orders), 8000);
  if (P.checkSites === false) return;
  const numbers = [...(P.tracked || []).map((p) => p.number), ...mail.filter((d) => d.number && d.state !== 'delivered').map((d) => d.number)];
  clearTimeout(trackTimer);
  trackTimer = setTimeout(() => refreshTracking(numbers, { mailAbout: mailStatusFor }), 5000);
}

// The card's list, kept for the Deliveries page (deliveries.html): { at, list }.
export const SHOWN = 'pkg:shown';
let savedList = '';

function paintCard() {
  const body = $('#deliveries-body');
  if (!body) return;
  const coming = shown.filter((d) => d.state !== 'delivered').length;
  // How many are on the way, 0 included while some were delivered: it opens the Deliveries page.
  const count = $('#deliveries-count');
  count.textContent = shown.length ? String(coming) : '';
  count.title = shown.length ? `See all ${shown.length} ${shown.length === 1 ? 'package' : 'packages'}` : '';
  const json = JSON.stringify(shown);
  if (json !== savedList) {
    savedList = json;
    local.set(SHOWN, { at: Date.now(), list: shown });
  }
  $('#card-deliveries').classList.toggle('is-empty', !shown.length);
  const none = settingsRef?.packages.fromMail === false ? 'Nothing being tracked. Add a tracking number in Settings → Package tracking.' : 'Nothing on the way. Shipping emails show up here with their delivery dates.';
  body.innerHTML = shown.length ? deliveryRows(shown) : `<p class="quiet">${none}</p>`;
  setTicker(
    'deliveries',
    shown.map((d) => {
      const when = d.state === 'delivered' ? null : d.due != null ? dateParts(d.due) : null;
      return { tag: d.label, title: d.title, meta: when ? `${when.day} ${when.date}` : '', href: d.href };
    }),
  );
}

export const deliveryTag = (d) => (d ? `<span class="pkg-tag s-${d.state}">${icon('box')}${esc(d.label)}</span>` : '');

// What the newest shipping email about a tracking number says, as a package status, for a
// package whose carrier page couldn't be read. It looks only at the emails already read.
export async function mailStatusFor(number) {
  const news = deliveriesFrom(await lastShippingMail()).find((d) => d.number === number);
  if (!news) return null;
  const status = { out: 'OutForDelivery', problem: 'Exception', delivered: 'Delivered' }[news.state] || 'InTransit';
  return { status, eta: status === 'Delivered' ? null : news.due, event: { text: `Email: ${news.title}`, at: news.at }, from: 'mail' };
}
