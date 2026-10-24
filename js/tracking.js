// Live package tracking from 17TRACK, which follows USPS, UPS, FedEx, DHL, Amazon and thousands
// of other carriers through one API. It needs a key from api.17track.net (sign-up asks for a
// business email address). New accounts get 200 tracking numbers free, once; checking on numbers
// already registered doesn't count against that. More are sold by the year.
// Daybook registers the tracking numbers it finds in shipping emails (while they're still on
// their way) and the ones you add in Settings, then asks for their status every half hour.
// Deliveries works as before without a key.
import { esc, local, errorText } from './util.js';
import { icon } from './icons.js';

const API = 'https://api.17track.net/track/v2.2';
const INFO = 'track:info'; // { [number]: { at, status, sub, eta, event: { text, place, at }, carrier, error } }
const REG = 'track:reg'; // { [number]: { at, ok, error } }: registering costs quota, so each is done once
const STALE = 30 * 60e3;
const RETRY = 6 * 3600e3;
const FORGET = 30 * 86400e3;
const BATCH = 40; // the most numbers 17TRACK takes in one call
const GAP = 400; // ms between calls: it allows 3 a second

class KeyRejected extends Error {}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(key, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { '17token': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new KeyRejected('17TRACK didn’t accept the key');
  if (res.status === 429) throw new Error('17TRACK says too many requests; trying again soon');
  if (!res.ok) throw new Error(`17TRACK returned ${res.status}`);
  const r = await res.json();
  if (r.code !== 0) {
    const why = r.data?.errors?.[0]?.message || r.message || `error ${r.code}`;
    if (/token|key|auth/i.test(why)) throw new KeyRejected(`17TRACK didn’t accept the key (${why})`);
    throw new Error(`17TRACK: ${why}`);
  }
  return r.data || {};
}

// 17TRACK's main statuses (v2.2 names them; v1 numbered them), as Deliveries' states.
const STATUS = {
  NotFound: { state: 'transit', label: 'Waiting for the carrier' },
  InfoReceived: { state: 'transit', label: 'Label created' },
  InTransit: { state: 'transit', label: 'In transit' },
  Expired: { state: 'problem', label: 'No news for a while' },
  AvailableForPickup: { state: 'problem', label: 'Ready for pickup' },
  OutForDelivery: { state: 'out', label: 'Out for delivery' },
  DeliveryFailure: { state: 'problem', label: 'Delivery attempt failed' },
  Delivered: { state: 'delivered', label: 'Delivered' },
  Exception: { state: 'problem', label: 'Needs attention' },
};
const V1 = { 0: 'NotFound', 10: 'InTransit', 20: 'Expired', 30: 'AvailableForPickup', 35: 'DeliveryFailure', 40: 'Delivered', 50: 'Exception' };

const time = (e) => Date.parse(e?.time_iso || e?.time_utc || e?.time || '') || null;

// One answer from gettrackinfo, cut down to what the card shows.
export function readTrack(item) {
  const t = item.track_info || {};
  const raw = t.latest_status?.status ?? item.track?.e;
  const status = STATUS[raw] ? raw : V1[raw] || 'NotFound';
  const provider = t.tracking?.providers?.[0];
  const ev = t.latest_event || provider?.events?.[0] || item.track?.z0;
  const eta = t.time_metrics?.estimated_delivery_date;
  return {
    at: Date.now(),
    status,
    sub: t.latest_status?.sub_status || '',
    eta: Date.parse(eta?.from || eta?.to || '') || null,
    event: ev ? { text: ev.description || ev.z || '', place: ev.location || ev.c || '', at: time(ev) || Date.parse(ev.a || '') || null } : null,
    carrier: provider?.provider?.name || '',
  };
}

export const loadTracking = async () => (await local.get(INFO)) || {};

// Registers the numbers not registered yet, then asks after the ones not checked lately. One
// Daybook page does this at a time; the others see the results through storage.
export function refreshTracking(key, numbers, force = false) {
  key = (key || '').trim();
  const wanted = [...new Set(numbers.filter(Boolean))];
  if (!key || !wanted.length) return Promise.resolve();
  return navigator.locks.request('tracking', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const now = Date.now();
    // After an error, wait a while before trying again rather than asking on every repaint.
    const last = (await local.get('track:status')) || {};
    if (!force && last.error && now - last.at < 10 * 60e3) return;
    const reg = (await local.get(REG)) || {};
    const info = await loadTracking();
    const fresh = wanted.filter((n) => !reg[n] || (!reg[n].ok && now - reg[n].at > RETRY));
    const stale = (n) => force || !info[n] || now - info[n].at > STALE;
    // Nothing to ask: write nothing, since a write tells every page to draw again.
    if (!fresh.length && !wanted.some((n) => reg[n]?.ok && stale(n))) return;
    let error = null;
    try {
      for (let i = 0; i < fresh.length; i += BATCH) {
        const data = await call(key, 'register', fresh.slice(i, i + BATCH).map((number) => ({ number, auto_detection: true })));
        for (const a of data.accepted || []) reg[a.number] = { at: now, ok: true };
        for (const r of data.rejected || []) {
          // Already registered (on this key, from another computer or an earlier try) is fine.
          const already = r.error?.code === -18019901;
          reg[r.number] = { at: now, ok: already, error: already ? '' : r.error?.message || 'rejected' };
          if (!already) info[r.number] = { ...info[r.number], at: now, error: r.error?.message || '17TRACK couldn’t take this number' };
        }
        await wait(GAP);
      }
      const due = wanted.filter((n) => reg[n]?.ok && stale(n));
      for (let i = 0; i < due.length; i += BATCH) {
        const data = await call(key, 'gettrackinfo', due.slice(i, i + BATCH).map((number) => ({ number })));
        for (const a of data.accepted || []) info[a.number] = readTrack(a);
        for (const r of data.rejected || []) info[r.number] = { ...info[r.number], at: now, error: r.error?.message || 'No answer for this number' };
        await wait(GAP);
      }
    } catch (err) {
      error = err;
    }
    for (const [n, v] of Object.entries(info)) if (now - (v.at || 0) > FORGET && !wanted.includes(n)) delete info[n];
    await local.set(REG, reg);
    await local.set(INFO, info);
    await local.set('track:status', { at: now, error: error ? errorText(error) : '', keyRejected: error instanceof KeyRejected });
  });
}

// Calls `fn` when tracking news arrives, from this page or another.
export function onTracking(fn) {
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes[INFO] || changes['track:status'])) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 200);
  });
}

// What a tracked package says now, in Deliveries' terms: { state, label, due, event, at }, or
// null before 17TRACK has answered.
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

// A tracking number's carrier, from its shape (or 17TRACK's name for it), for the link.
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

// The Package tracking part of Settings: the packages you've added, with what 17TRACK last
// said about each, a form to add one, and the key's quota.
export async function mountTracking(el, draft, changed) {
  const P = draft.packages;
  const info = await loadTracking();
  const status = (await local.get('track:status')) || {};
  if (!el.isConnected) return;
  const line = (p) => {
    const t = trackedState(info[p.number]);
    const err = info[p.number]?.error;
    return t ? `${t.label}${t.event?.text ? ` · ${t.event.text}` : ''}` : err || (P.trackKey ? 'Checking with 17TRACK…' : 'Add a 17TRACK key to follow it');
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
      <p class="hint trk-msg" aria-live="polite">${esc(msg || (status.error ? `Last check: ${status.error}.` : ''))}</p>`;
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
    paint(P.trackKey ? 'Added. Daybook checks on it with 17TRACK when you close Settings.' : 'Added. Add a 17TRACK key above to follow it live.');
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
