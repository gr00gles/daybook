// Deliveries: shipping emails spotted among your mail, with a link to the carrier's tracking
// page when the email carries a tracking number. Everything is read from the subject and the
// preview text; nothing leaves your computer except the Gmail search below.
import { esc, safeUrl, cached, relTime } from './util.js';
import { gmailApi } from './gauth.js';
import { icon } from './icons.js';

const CARRIERS = {
  ups: { name: 'UPS', track: (n) => `https://www.ups.com/track?tracknum=${n}` },
  usps: { name: 'USPS', track: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  fedex: { name: 'FedEx', track: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  dhl: { name: 'DHL', track: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}` },
  amazon: { name: 'Amazon', track: (n) => `https://track.amazon.com/tracking/${n}` },
};

// Tracking numbers, most distinctive first. FedEx and DHL numbers are plain digits, so they
// only count when the email names the carrier.
const NUMBERS = [
  ['ups', /\b1Z[0-9A-Z]{16}\b/],
  ['amazon', /\bTBA\d{12}\b/],
  ['usps', /(?<![\d])9[2-5](?: ?\d){20}(?:(?: ?\d){4})?(?![\d])/],
  ['usps', /\b[A-Z]{2}\d{9}US\b/],
  ['fedex', /(?<![\d-])(?:\d{12}|\d{15}|\d{20}|\d{22})(?![\d-])/, /fedex/i],
  ['dhl', /(?<![\d-])\d{10}(?![\d-])/, /\bdhl\b/i],
];

const SENDERS = [
  ['amazon', /amazon/i],
  ['ups', /\bups\b/i],
  ['fedex', /fedex/i],
  ['usps', /\busps\b|postal service|informed delivery/i],
  ['dhl', /\bdhl\b/i],
];

const RANK = { out: 0, problem: 1, soon: 2, transit: 3, delivered: 4 };
const DAY = /(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}/i;

function statusOf(text) {
  if (/delivery (?:attempt|exception)|attempted delivery|missed (?:your )?delivery|unable to deliver|could(?:n.?t| not) (?:be )?deliver|\bdelay(?:ed)?\b|held at|return(?:ed|ing) to sender|action required/i.test(text))
    return ['problem', 'Needs attention'];
  if (/out for delivery|arriving today|(?:delivery|delivered|deliver) today|on the truck/i.test(text)) return ['out', 'Out for delivery'];
  if (/\bdelivered\b/i.test(text) && !/\bbe delivered|not (?:been |yet )?delivered|undelivered/i.test(text)) return ['delivered', 'Delivered'];
  if (/(?:arriving|arrives|delivery|deliver(?:ed)?) tomorrow/i.test(text)) return ['soon', 'Arriving tomorrow'];
  const day = text.match(new RegExp(`(?:arriving|arrives|(?:expected|estimated|scheduled) delivery|expected)(?: on| by| date)?:? (${DAY.source})`, 'i'));
  if (day) return ['transit', `Arriving ${day[1].replace(/^(\w{3})\w*day$/i, '$1')}`];
  if (/\bshipped\b|on (?:its|the) way|in transit|dispatched|label created|ready (?:to|for) ship|has shipped|shipment|tracking (?:number|info)/i.test(text))
    return ['transit', 'On the way'];
  return null;
}

// Status words alone also turn up in ads ("free delivery today"), so without a tracking
// number the subject has to talk about an order or package and not sound like an offer.
const ABOUT_ORDER = /\b(?:order|package|parcel|shipment|delivery|delivered|shipped|tracking|item)s?\b/i;
const PROMO = /\bfree\b|\bsale\b|% off|\bdeals?\b|\boffer\b|\bsave\b|coupon|shop now|subscribe/i;

function numberIn(text, context) {
  for (const [carrier, re, needs] of NUMBERS) {
    if (needs && !needs.test(context)) continue;
    const m = text.match(re);
    if (!m) continue;
    const n = m[0].replace(/ /g, '');
    if (carrier === 'usps' && /^9/.test(n) && n.length !== 22 && n.length !== 26) continue;
    return { carrier, number: n };
  }
  return null;
}

function titleOf(subject, from) {
  const t = subject
    .replace(/^(?:fwd?|re):\s*/i, '')
    .replace(/^(?:shipped|delivered|out for delivery|arriving[^:]*|ordered|(?:\w+ )?update)\s*:\s*/i, '')
    .replace(/^["“'](.+?)["”']/, '$1')
    .trim();
  // "Your package has been delivered" says less than who sent it.
  if (from && (!t || /^(?:your|a|an)\b.{0,30}\b(?:order|package|parcel|shipment|item|delivery)\b/i.test(t))) return from.slice(0, 70);
  return (t || 'Package').slice(0, 70);
}

// One mail item ({ subject, snippet, from, at, url }) → a delivery, or null.
export function deliveryOf(m) {
  if (!m) return null;
  const subject = m.subject || '';
  const context = `${m.from || ''} ${subject} ${m.snippet || ''}`;
  const found = numberIn(`${subject} ${m.snippet || ''}`.toUpperCase(), context);
  const fromSubject = statusOf(subject);
  const fromSnippet = found || ABOUT_ORDER.test(subject) ? statusOf(m.snippet || '') : null;
  // "Shipped: …" with "Arriving Thursday" in the preview: the preview says more.
  const status = fromSubject?.[0] === 'transit' && fromSnippet && (fromSnippet[0] !== 'transit' || fromSnippet[1].startsWith('Arriving')) && fromSnippet[0] !== 'delivered'
    ? fromSnippet
    : fromSubject || fromSnippet;
  if (!found && (!status || !ABOUT_ORDER.test(subject) || PROMO.test(subject))) return null;
  const carrier = found?.carrier || SENDERS.find(([, re]) => re.test(`${m.from || ''} ${subject}`))?.[0] || '';
  const [state, label] = status || ['transit', 'Tracking'];
  return {
    key: found?.number || `${carrier}|${titleOf(subject, m.from).toLowerCase()}`,
    carrier,
    number: found?.number || '',
    state,
    label,
    title: titleOf(subject, m.from),
    from: m.from || '',
    at: m.at || Date.now(),
    href: found ? CARRIERS[found.carrier].track(found.number) : safeUrl(m.url),
    mailUrl: safeUrl(m.url),
  };
}

// The deliveries worth showing: the latest word on each package, delivered ones for 2 days.
export function deliveriesFrom(items) {
  const now = Date.now();
  const best = new Map();
  for (const m of items) {
    const d = deliveryOf(m);
    if (!d) continue;
    if (now - d.at > (d.state === 'delivered' ? 2 : 14) * 86400e3) continue;
    const prev = best.get(d.key);
    if (!prev || d.at > prev.at) best.set(d.key, d);
  }
  return [...best.values()].sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);
}

export function deliveriesHtml(list, max = 4) {
  if (!list.length) return '';
  const shown = list.slice(0, max);
  return `<div class="deliveries" role="group" aria-label="Deliveries">
    ${shown
      .map((d) => {
        const who = CARRIERS[d.carrier]?.name || '';
        const tip = [d.title, d.number && `${who} ${d.number}`, `email ${relTime(d.at)}`].filter(Boolean).join(' · ');
        return `<a class="dl s-${d.state}" href="${esc(d.href)}" title="${esc(tip)}">
          ${icon('box')}
          <span class="dl-text"><span class="dl-status">${esc(d.label)}</span><span class="dl-title">${esc(d.title)}</span></span>
          ${who ? `<span class="dl-carrier">${esc(who)}</span>` : ''}
        </a>`;
      })
      .join('')}
    ${list.length > max ? `<span class="dl-more">+${list.length - max} more</span>` : ''}
  </div>`;
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
            snippet: decodeEntities(m.snippet || ''),
            at: Number(m.internalDate) || Date.now(),
            url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${m.threadId}`,
          };
        });
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
