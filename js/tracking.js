// Live package status, free and without a key: Daybook opens each package's page on the carrier's
// own site (UPS, USPS, FedEx, DHL, Amazon) out of sight, in a frame on the new tab page, and reads
// the status and delivery day off it (track-page.js), the way you would. Carriers don't let other
// pages show theirs in a frame, so a session rule lifts that for Daybook's own frames only. When
// a page can't be read, the newest email that mentions the tracking number stands in. Packages
// come from shipping emails (while they're on their way) and from the ones you add in Settings.
// One page at a time, every couple of hours, from one tab at a time.
import { $, esc, local } from './util.js';
import { icon } from './icons.js';

const INFO = 'track:info'; // { [number]: { at, status, eta, event: { text, at }, carrier, from: 'page' | 'mail', error } }
const RULE = 4101; // the session rule that lets carrier pages load in Daybook's frames
const PER_RUN = 6; // pages read each time, so a new tab isn't kept busy
const WAIT = 45e3; // how long a page gets to show a status
const FORGET = 30 * 86400e3;

// Each carrier's tracking page, and the hosts it may move through.
export const PAGES = {
  ups: { name: 'UPS', url: (n) => `https://www.ups.com/track?loc=en_US&tracknum=${n}&requester=ST/trackdetails`, hosts: ['ups.com'] },
  usps: { name: 'USPS', url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`, hosts: ['usps.com'] },
  fedex: { name: 'FedEx', url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`, hosts: ['fedex.com'] },
  dhl: { name: 'DHL', url: (n) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`, hosts: ['dhl.com'] },
  amazon: { name: 'Amazon', url: (n) => `https://track.amazon.com/tracking/${n}`, hosts: ['amazon.com'] },
};
const HOSTS = Object.values(PAGES).flatMap((p) => p.hosts);

// Package statuses, as Deliveries' states.
const STATUS = {
  NotFound: { state: 'transit', label: 'Waiting for the carrier' },
  InfoReceived: { state: 'transit', label: 'Label created' },
  InTransit: { state: 'transit', label: 'In transit' },
  AvailableForPickup: { state: 'problem', label: 'Ready for pickup' },
  OutForDelivery: { state: 'out', label: 'Out for delivery' },
  Exception: { state: 'problem', label: 'Needs attention' },
  Delivered: { state: 'delivered', label: 'Delivered' },
};

// Status words, most telling first: a missed delivery says "delivery" too, and "Out for
// Delivery" isn't "Delivered".
const PHRASES = [
  ['Exception', /attempt|exception|delay|held at|unable to|missed|action (?:is )?required|return(?:ed|ing) to (?:the )?sender|undeliverable|could ?n[o’']?t (?:be )?deliver|issue with/i],
  ['OutForDelivery', /out for delivery|on the truck|with (?:a|your|the) (?:driver|courier)/i],
  ['AvailableForPickup', /ready for pick ?up|available for pick ?up|awaiting (?:collection|pick ?up)|at (?:a|the) (?:pickup|access) point/i],
  ['Delivered', /\bdelivered\b/i],
  ['InfoReceived', /label created|information received|pre-shipment|shipment created|order processed|ready to ship|awaiting item|not yet in system/i],
  ['InTransit', /in transit|on the way|on its way|arriv|departed|picked up|accepted|processed|moving through|in possession/i],
];
const NOT_DELIVERED = /not (?:yet )?delivered|be delivered|(?:estimated|expected|scheduled|anticipated) delivery/i;

export function statusIn(text) {
  for (const [status, re] of PHRASES) {
    if (!re.test(text)) continue;
    if (status === 'Delivered' && NOT_DELIVERED.test(text) && !/\bdelivered[,:]? /i.test(text.replace(NOT_DELIVERED, ''))) continue;
    return status;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

// The day a line names, as local midnight: "Tuesday, October 28", "Oct 28, 2026", "28 OCTOBER
// 2026", "10/28/26", "today" or "tomorrow". A date months back means next year.
export function dateIn(line, now = Date.now()) {
  const t = String(line || '').toLowerCase();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const at = (y, m, d) => {
    let ms = new Date(y ?? today.getFullYear(), m, d).getTime();
    if (y == null && ms < today.getTime() - 120 * 86400e3) ms = new Date(today.getFullYear() + 1, m, d).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  let m = t.match(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`));
  if (m) return at(m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[1]), Number(m[2]));
  m = t.match(new RegExp(`\\b(\\d{1,2})\\s+${MON}(?:,?\\s+(\\d{4}))?(?!\\d)`));
  if (m) return at(m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[2]), Number(m[1]));
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) return at(m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, Number(m[1]) - 1, Number(m[2]));
  if (/\btomorrow\b/.test(t)) return today.getTime() + 86400e3;
  if (/\btoday\b|\btonight\b/.test(t)) return today.getTime();
  return null;
}

// What a carrier's page showed (from track-page.js), as a package's status.
// Only the page's headlines count: the whole page also has menus ("Out for delivery alerts")
// and footers that would read as a status.
export function readPage(msg, carrier) {
  const heads = (msg.found || []).map((c) => c.text);
  const head = heads.find((h) => statusIn(h)) || '';
  const status = statusIn(head);
  if (!status) return { error: `Couldn’t find the status on ${PAGES[carrier]?.name || 'the carrier'}’s page` };
  const delivered = status === 'Delivered';
  // When it was delivered is usually in a line near the headline; when it's due, under a label.
  const lines = delivered ? [head, ...heads.filter((h) => /deliver/i.test(h)), ...(msg.dates || [])] : [...(msg.dates || []), head];
  const when = lines.map((l) => dateIn(l)).find(Boolean) ?? null;
  return { status, eta: delivered ? null : when, event: { text: head, at: delivered ? when : null }, carrier: PAGES[carrier]?.name || '', from: 'page' };
}

export const loadTracking = async () => (await local.get(INFO)) || {};

// How long a package's status holds before it's looked at again.
function stale(t, now) {
  if (!t) return true;
  if (t.status === 'Delivered') return false;
  const age = now - (t.at || 0);
  if (t.error) return age > 3 * 3600e3;
  return age > (t.status === 'OutForDelivery' ? 30 * 60e3 : 2 * 3600e3);
}

// Lets the carriers' pages load in frames that Daybook itself opens, and nowhere else.
async function allowFrames() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE],
    addRules: [
      {
        id: RULE,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'].map((header) => ({ header, operation: 'remove' })),
        },
        condition: { requestDomains: HOSTS, resourceTypes: ['sub_frame'], initiatorDomains: [chrome.runtime.id] },
      },
    ],
  });
}

function frames() {
  let box = $('#track-frames');
  if (!box) {
    box = document.createElement('div');
    box.id = 'track-frames';
    box.setAttribute('aria-hidden', 'true');
    document.body.append(box);
  }
  return box;
}

// Opens one package's page out of sight and waits for track-page.js to report what it shows.
function readCarrierPage(number, carrier) {
  const page = PAGES[carrier];
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    // No navigating this tab, no pop-ups: the page only gets to show itself.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    frame.setAttribute('tabindex', '-1');
    frame.src = page.url(encodeURIComponent(number));
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(heard);
      frame.remove();
      resolve(result);
    };
    const heard = (msg, sender) => {
      if (msg?.type !== 'track-page' || sender.id !== chrome.runtime.id) return;
      let host = '';
      try {
        host = new URL(sender.url).hostname;
      } catch {}
      if (page.hosts.some((h) => host === h || host.endsWith(`.${h}`))) finish(readPage(msg, carrier));
    };
    chrome.runtime.onMessage.addListener(heard);
    timer = setTimeout(() => finish({ error: `${page.name}’s page didn’t load` }), WAIT);
    frames().append(frame);
  });
}

// Reads the pages of the packages due a look, a few each time. `mailAbout(number)` finds the
// newest email about a number, for when its page can't be read. One Daybook tab does this at a
// time; the others see the results through storage.
export function refreshTracking(numbers, { mailAbout, force = false } = {}) {
  const wanted = [...new Set(numbers.filter(Boolean))];
  if (!wanted.length) return Promise.resolve();
  return navigator.locks.request('tracking', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const now = Date.now();
    let info = await loadTracking();
    const due = wanted.filter((n) => PAGES[carrierOf(n, info[n]?.carrier)] && (force || stale(info[n], now))).slice(0, PER_RUN);
    if (!due.length) return;
    try {
      await allowFrames();
    } catch (err) {
      console.warn('[daybook] tracking frames:', err);
      return;
    }
    for (const number of due) {
      const carrier = carrierOf(number, info[number]?.carrier);
      let result = await readCarrierPage(number, carrier);
      if (result.error && mailAbout) result = (await mailAbout(number).catch(() => null)) || result;
      info = await loadTracking();
      // A page that can't be read now keeps what was known before, marked as old news.
      info[number] = result.error && info[number]?.status ? { ...info[number], at: Date.now(), error: result.error } : { ...result, at: Date.now() };
      await local.set(INFO, info);
    }
    for (const [n, v] of Object.entries(info)) if (now - (v.at || 0) > FORGET && !wanted.includes(n)) delete info[n];
    await local.set(INFO, info);
  });
}

// Calls `fn` when tracking news arrives, from this page or another.
export function onTracking(fn) {
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[INFO]) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 200);
  });
}

// What a tracked package says now, in Deliveries' terms: { state, label, due, event, at }, or
// null before any status is known.
export function trackedState(t) {
  if (!t?.status) return null;
  const s = STATUS[t.status] || STATUS.InTransit;
  const midnight = (ms) => new Date(ms).setHours(0, 0, 0, 0);
  if ((s.state === 'transit' || s.state === 'out') && t.eta) {
    const days = Math.round((midnight(t.eta) - midnight(Date.now())) / 86400e3);
    if (t.status !== 'OutForDelivery' && days === 0) return { ...t, state: 'out', label: 'Arriving today', due: midnight(t.eta) };
    if (days === 1) return { ...t, state: 'soon', label: 'Arriving tomorrow', due: midnight(t.eta) };
    if (days > 1) {
      const day = new Date(t.eta).toLocaleDateString(undefined, days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
      return { ...t, state: 'transit', label: `Arriving ${day}`, due: midnight(t.eta) };
    }
  }
  return { ...t, state: s.state, label: s.label, due: null };
}

// A tracking number's carrier, from its shape (or a carrier's name), for its page and link.
export function carrierOf(number, name = '') {
  const n = number.toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n) || /\bups\b/i.test(name)) return 'ups';
  if (/^TBA\d{12}$/.test(n) || /amazon/i.test(name)) return 'amazon';
  if (/^[A-Z]{2}\d{9}US$/.test(n) || /^9[2-5]\d{20}(\d{4})?$/.test(n) || /usps|postal/i.test(name)) return 'usps';
  if (/fedex/i.test(name) || /^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(n)) return 'fedex';
  if (/\bdhl\b/i.test(name) || /^\d{10}$/.test(n)) return 'dhl';
  return '';
}

export const cleanNumber = (s) => String(s || '').replace(/[\s-]+/g, '').toUpperCase();

// The Package tracking part of Settings: the packages you've added, with what was last seen
// about each, and a form to add one.
export async function mountTracking(el, draft, changed) {
  const P = draft.packages;
  const info = await loadTracking();
  if (!el.isConnected) return;
  const line = (p) => {
    const t = trackedState(info[p.number]);
    const err = info[p.number]?.error;
    if (!carrierOf(p.number)) return 'Daybook can’t tell whose number this is; it links to 17TRACK’s free lookup';
    if (t) return `${t.label}${t.event?.text && t.event.text !== t.label ? ` · ${t.event.text}` : ''}${err ? ' (older news)' : ''}`;
    return err || (P.checkSites === false ? 'Turn on checking carrier pages to follow it' : 'Checking with the carrier…');
  };
  const paint = (msg = '') => {
    el.innerHTML = `${
      P.tracked.length
        ? `<ul class="trk-list">${P.tracked
            .map(
              (p, i) => `<li><span class="trk-text"><span class="trk-name">${esc(p.name || p.number)}</span><span class="trk-line">${esc(p.name ? `${p.number} · ${line(p)}` : line(p))}</span></span>
              <button class="icon-btn" type="button" data-trk-remove="${i}" aria-label="Stop tracking ${esc(p.name || p.number)}">${icon('close')}</button></li>`,
            )
            .join('')}</ul>`
        : '<p class="hint">No packages added yet.</p>'
    }
      <div class="row wrap trk-add">
        <label class="field"><span>Tracking number</span><input type="text" data-trk="number" placeholder="1Z999AA10123456784" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>What it is (optional)</span><input type="text" data-trk="name" placeholder="New boots" autocomplete="off"></label>
        <button class="btn small" type="button" data-trk-add>${icon('plus')}Track it</button>
      </div>
      <p class="hint trk-msg" aria-live="polite">${esc(msg)}</p>`;
  };
  el.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-trk-remove]');
    if (remove) {
      P.tracked.splice(Number(remove.dataset.trkRemove), 1);
      changed();
      paint();
      return;
    }
    if (!e.target.closest('[data-trk-add]')) return;
    const number = cleanNumber(el.querySelector('[data-trk="number"]').value);
    const name = el.querySelector('[data-trk="name"]').value.trim().slice(0, 60);
    if (!/^[A-Z0-9]{5,50}$/.test(number)) return paint('That doesn’t look like a tracking number: letters and digits, 5 to 50 of them.');
    if (P.tracked.some((p) => p.number === number)) return paint('That package is already on the list.');
    P.tracked.push({ number, name, added: Date.now() });
    changed();
    const who = PAGES[carrierOf(number)]?.name;
    paint(who ? `Added. Daybook reads ${who}’s page for it when you close Settings.` : 'Added. Daybook can’t tell whose number this is, so it links to 17TRACK’s free lookup instead.');
    el.querySelector('[data-trk="number"]').focus();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('[data-trk]')) {
      e.preventDefault();
      el.querySelector('[data-trk-add]').click();
    }
  });
  paint();
}
