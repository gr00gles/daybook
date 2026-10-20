// New uploads from your YouTube subscriptions. The subscription list comes from the YouTube
// Data API (once a day); new videos come from each channel's public feed, which costs no API
// quota. With Shorts hidden, the feed used is the channel's long-form uploads list (UULF…),
// which leaves out Shorts and live streams.
import { $, esc, local, relTime, errorText, showToast } from './util.js';
import { youtubeApi, googleAccount, googleConfigured } from './gauth.js';
import { icon } from './icons.js';

const SUBS_KEY = 'yt:subs';
const FEED_KEY = 'yt:feed';
// Videos you've watched (opened from here, or marked with the eye button), on this computer.
// YouTube doesn't let apps read your watch history, so this is Daybook's own list.
const WATCHED_KEY = 'yt:watched';
const SUBS_MAX_AGE = 24 * 3600e3;
const FEED_MAX_AGE = 15 * 60e3;
// Each refresh checks the channels checked longest ago, at most this many, so a long
// subscription list is spread out instead of hitting YouTube all at once.
const BATCH = 40;
const BACKOFF = 60 * 60e3;
// When a channel's feed fails, ask the YouTube Data API instead (1 quota unit), at most this
// often per channel.
const API_EVERY = 60 * 60e3;
const WINDOW = 7 * 86400e3; // uploads older than a week aren't news
const ROLODEX = 15; // how many recent uploads to flip through
const FLIP_EVERY = 7000;
const NEW_FOR = 24 * 3600e3;

let settingsRef;
let state = { status: 'loading', videos: [], error: null, at: 0, failed: 0 };
let current = 0;
let flipTimer = null;
let paused = false;
let refreshing = null;
let watched = new Map(); // video id -> when

const unwatched = () => state.videos.filter((v) => !watched.has(v.id));

async function setWatched(id, on) {
  // Start from what's stored: another tab may have marked videos (or Disconnect cleared them).
  watched = new Map(Object.entries((await local.get(WATCHED_KEY)) || {}));
  if (on) watched.set(id, Date.now());
  else watched.delete(id);
  // Uploads leave the list after a week, so a month of history is plenty.
  for (const [k, at] of watched) if (Date.now() - at > 30 * 86400e3) watched.delete(k);
  await local.set(WATCHED_KEY, Object.fromEntries(watched));
}

async function listSubscriptions({ interactive = false, force = false } = {}) {
  const stored = await local.get(SUBS_KEY);
  if (stored && !force && Date.now() - stored.at < SUBS_MAX_AGE) return stored.list;
  const list = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical', fields: 'nextPageToken,items(snippet(title,resourceId/channelId))' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await youtubeApi(`/subscriptions?${q}`, { interactive });
    interactive = false; // the first call asked; the rest reuse that permission
    for (const it of page.items || []) {
      const id = it.snippet?.resourceId?.channelId;
      if (id) list.push({ id, title: it.snippet.title || '' });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken && list.length < 1000);
  await local.set(SUBS_KEY, { at: Date.now(), list });
  return list;
}

class Throttled extends Error {}

function feedUrl(ch) {
  if (settingsRef.youtube.hideShorts && ch.id.startsWith('UC'))
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${encodeURIComponent(ch.id.slice(2))}`;
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch.id)}`;
}

async function channelUploads(ch) {
  const res = await fetch(feedUrl(ch), { credentials: 'omit', cache: 'no-store' });
  if (res.status === 403 || res.status === 429) throw new Throttled(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // A "we've detected unusual traffic" page comes back as HTML instead of a feed.
  if (!/<feed[\s>]/.test(text)) throw new Throttled('not a feed');
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  const cutoff = Date.now() - WINDOW;
  return [...xml.getElementsByTagName('entry')]
    .map((e) => {
      const id = e.getElementsByTagName('yt:videoId')[0]?.textContent?.trim();
      return {
        id,
        title: e.getElementsByTagName('title')[0]?.textContent?.trim() || 'Untitled video',
        channel: e.getElementsByTagName('name')[0]?.textContent?.trim() || ch.title,
        channelId: ch.id,
        at: Date.parse(e.getElementsByTagName('published')[0]?.textContent || ''),
      };
    })
    // Scheduled premieres show up with a future time before they air.
    .filter((v) => v.id && v.at > cutoff && v.at <= Date.now())
    .slice(0, 5);
}

// Runs fn over items, a few at a time. If YouTube starts refusing requests, the rest are
// skipped and the caller backs off.
async function pool(items, size, fn) {
  const out = new Array(items.length).fill(undefined);
  const errors = new Array(items.length).fill('');
  let next = 0;
  let throttled = false;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length && !throttled) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          out[i] = null;
          errors[i] = err?.message || String(err);
          if (err instanceof Throttled) throttled = true;
        }
      }
    }),
  );
  return { out, errors, throttled };
}

async function apiUploads(ch) {
  const longOnly = settingsRef.youtube.hideShorts;
  const q = new URLSearchParams({
    part: 'snippet,contentDetails',
    maxResults: '5',
    // UULF… is the channel's long-form uploads (no Shorts or live); UU… is every upload.
    playlistId: `${longOnly ? 'UULF' : 'UU'}${ch.id.slice(2)}`,
    fields: 'items(snippet(title,channelTitle,resourceId/videoId),contentDetails/videoPublishedAt)',
  });
  let page;
  try {
    page = await youtubeApi(`/playlistItems?${q}`);
  } catch (err) {
    // A channel with no long-form videos has no UULF list at all.
    if (longOnly && /cannot be found|not ?found/i.test(err.message)) return [];
    throw err;
  }
  const now = Date.now();
  return (page.items || [])
    .map((it) => ({
      id: it.snippet?.resourceId?.videoId,
      title: it.snippet?.title || 'Untitled video',
      channel: it.snippet?.channelTitle || ch.title,
      channelId: ch.id,
      at: Date.parse(it.contentDetails?.videoPublishedAt || ''),
    }))
    .filter((v) => v.id && v.at > now - WINDOW && v.at <= now);
}

async function refreshFeed(subs, { all = false } = {}) {
  const prev = (await local.get(FEED_KEY)) || {};
  const mode = settingsRef.youtube.hideShorts ? 'long' : 'all';
  const fresh = prev.mode === mode;
  const byChannel = fresh ? { ...prev.byChannel } : {};
  const checked = fresh ? { ...prev.checked } : {};
  if (!all && prev.pausedUntil > Date.now()) return { ...prev, byChannel, checked };
  const due = [...subs].sort((a, b) => (checked[a.id] || 0) - (checked[b.id] || 0)).slice(0, all ? subs.length : BATCH);
  const { out, errors, throttled } = await pool(due, 4, channelUploads);
  const apiChecked = fresh ? { ...prev.apiChecked } : {};
  const reasons = {};
  const retry = [];
  due.forEach((ch, i) => {
    if (out[i]) {
      byChannel[ch.id] = out[i];
      checked[ch.id] = Date.now();
    } else {
      // Failed, or skipped because YouTube pushed back: try the API for this one.
      if (out[i] === null) checked[ch.id] = Date.now();
      retry.push({ ch, why: errors[i] || 'skipped' });
    }
  });
  const apiDue = retry.filter(({ ch }) => Date.now() - (apiChecked[ch.id] || 0) > API_EVERY);
  const api = await pool(
    apiDue.map((r) => r.ch),
    3,
    apiUploads,
  );
  let failed = 0;
  apiDue.forEach(({ ch, why }, i) => {
    apiChecked[ch.id] = Date.now();
    if (api.out[i]) byChannel[ch.id] = api.out[i];
    else {
      failed++;
      const reason = /^HTTP|not a feed|fetch/i.test(why) ? why : 'error';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  });
  // Channels whose API check is still cooling down keep what they had; count them only if
  // they have nothing at all.
  for (const { ch, why } of retry) {
    if (apiDue.some((r) => r.ch === ch) || byChannel[ch.id]) continue;
    failed++;
    reasons[why] = (reasons[why] || 0) + 1;
  }
  // Drop channels you've unsubscribed from, and uploads that have aged out.
  const ids = new Set(subs.map((c) => c.id));
  for (const id of Object.keys(byChannel)) {
    if (!ids.has(id)) delete byChannel[id];
    else byChannel[id] = byChannel[id].filter((v) => v.at > Date.now() - WINDOW);
  }
  const entry = { at: Date.now(), mode, byChannel, checked, apiChecked, failed, reasons, channels: subs.length, pausedUntil: throttled ? Date.now() + BACKOFF : 0 };
  await local.set(FEED_KEY, entry);
  return entry;
}

function applyFeed(entry) {
  const videos = Object.values(entry.byChannel || {})
    .flat()
    .sort((a, b) => b.at - a.at);
  state = { status: 'ready', videos, error: null, at: entry.at, failed: entry.failed, reasons: entry.reasons || {}, channels: entry.channels, paused: entry.pausedUntil > Date.now() };
}

async function load({ interactive = false, force = false } = {}) {
  const stored = await local.get(FEED_KEY);
  const mode = settingsRef.youtube.hideShorts ? 'long' : 'all';
  if (stored?.mode === mode) {
    applyFeed(stored);
    if (!force && Date.now() - stored.at < FEED_MAX_AGE) return;
    render();
  }
  const subs = await listSubscriptions({ interactive, force: force && interactive });
  // The very first look (or after switching Shorts on/off) checks every channel.
  applyFeed(await refreshFeed(subs, { all: stored?.mode !== mode || interactive }));
}

export async function refreshYouTube(S, force = false) {
  settingsRef = S;
  if (!$('#yt-body')) return;
  if (!googleConfigured() || !(await googleAccount())) {
    state = { status: 'no-google', videos: [] };
    render();
    return;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await load({ force });
    } catch (err) {
      state = { ...state, status: err.code === 'needs-google' ? 'needs-permission' : state.videos.length ? 'ready' : 'error', error: err };
    }
    render();
  })().finally(() => (refreshing = null));
  return refreshing;
}

const whyText = () =>
  Object.entries(state.reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why} ×${n}`)
    .join(', ') || 'no reason given';

const isNew = (v) => Date.now() - v.at < NEW_FOR;

// ---- Rolodex ---------------------------------------------------------------------------

function cardHtml(v, i) {
  return `<div class="rolo-card" data-i="${i}" data-id="${esc(v.id)}">
    <a class="rolo-link" href="https://www.youtube.com/watch?v=${esc(encodeURIComponent(v.id))}" data-yt-open="${esc(v.id)}">
      <span class="rolo-thumb"><img src="https://i.ytimg.com/vi/${esc(encodeURIComponent(v.id))}/hqdefault.jpg" alt="" ${i < 3 ? '' : 'loading="lazy"'}>${isNew(v) ? '<span class="rolo-new">New</span>' : ''}</span>
      <span class="rolo-text">
        <span class="rolo-title">${esc(v.title)}</span>
        <span class="rolo-meta">${esc(v.channel)} · ${relTime(v.at)}</span>
      </span>
    </a>
    <button class="rolo-watched" type="button" data-yt="watched" data-id="${esc(v.id)}" title="Mark as watched" aria-label="Mark as watched: ${esc(v.title)}">${icon('eye')}</button>
  </div>`;
}

// Each card's place in the stack: 0 is in front, 1 and 2 peek out behind, the card just
// flipped past drops away, the rest wait out of sight.
function placeCards() {
  const cards = [...document.querySelectorAll('#yt-body .rolo-card')];
  const n = cards.length;
  cards.forEach((card, i) => {
    const pos = (i - current + n) % n;
    card.dataset.pos = pos === n - 1 && n > 3 ? 'gone' : pos <= 2 ? String(pos) : 'wait';
    card.setAttribute('aria-hidden', String(pos !== 0));
    for (const el of card.querySelectorAll('a, button')) el.tabIndex = pos === 0 ? 0 : -1;
  });
  const posEl = $('#yt-pos');
  if (posEl) posEl.textContent = n ? `${current + 1} of ${n}` : '';
}

function flip(step) {
  const n = Math.min(ROLODEX, unwatched().length);
  if (n < 2) return;
  current = (current + step + n) % n;
  placeCards();
}

function startFlipping() {
  clearInterval(flipTimer);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  flipTimer = setInterval(() => {
    if (!paused && document.visibilityState === 'visible') flip(1);
  }, FLIP_EVERY);
}

function render() {
  const body = $('#yt-body');
  if (!body) return;
  const today = unwatched().filter(isNew).length;
  $('#yt-count').textContent = today ? `${today} new` : '';
  $('#yt-updated').textContent = state.at ? `checked ${relTime(state.at) === 'now' ? 'just now' : `${relTime(state.at)} ago`}` : '';
  const foot = $('#yt-foot');

  if (state.status === 'loading') {
    body.innerHTML = '<p class="quiet">Checking your subscriptions…</p>';
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'no-google') {
    body.innerHTML = `<div class="notice setup"><p>Connect Google to see the latest videos from the YouTube channels you subscribe to.</p><button class="btn small primary" type="button" data-open-settings="accounts">Connect Google</button></div>`;
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'needs-permission') {
    body.innerHTML = `<div class="notice setup"><p><strong>See the latest uploads from your subscriptions.</strong> Google will ask once for permission to view your YouTube account. Daybook only reads your subscription list.</p><button class="btn small primary" type="button" data-yt="connect">Show my subscriptions</button></div>`;
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'error' && !state.videos.length) {
    body.innerHTML = `<p class="notice warn">YouTube: ${esc(errorText(state.error))}.</p>${state.error?.code === 'needs-google' ? '' : '<button class="btn small" type="button" data-yt="retry">Try again</button>'}`;
    foot.innerHTML = '';
    return;
  }

  const list = unwatched().slice(0, ROLODEX);
  if (current >= list.length) current = 0;
  body.innerHTML = list.length
    ? `<div class="rolo" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Latest uploads from your subscriptions">
        <div class="rolo-stack">${list.map(cardHtml).join('')}</div>
        ${list.length > 1 ? `<div class="rolo-nav">
          <button class="icon-btn small" type="button" data-yt="prev" aria-label="Previous video">${icon('chevron-left')}</button>
          <span class="rolo-pos" id="yt-pos" aria-live="polite"></span>
          <button class="icon-btn small" type="button" data-yt="next" aria-label="Next video">${icon('chevron-right')}</button>
        </div>` : ''}
      </div>`
    : state.failed && state.failed >= state.channels
      ? `<p class="notice warn">YouTube didn’t send videos for any of your ${state.channels} channels (${esc(whyText())}). Daybook keeps trying every few minutes.</p>`
      : state.videos.length
        ? '<p class="quiet is-empty">You’re all caught up: every upload from this week is marked as watched.</p>'
        : '<p class="quiet is-empty">No uploads from your subscriptions this week.</p>';
  if (state.error) body.insertAdjacentHTML('beforeend', `<p class="notice warn">Couldn’t refresh: ${esc(errorText(state.error))}.</p>`);
  placeCards();
  foot.innerHTML = `<a class="foot-link" href="https://www.youtube.com/feed/subscriptions">${icon('external')}Subscriptions</a>${
    state.paused
      ? '<span class="stamp">YouTube asked Daybook to slow down; checking again within the hour</span>'
      : state.failed
        ? `<span class="stamp" title="${esc(whyText())}">${state.failed} of ${state.channels} channels didn’t answer</span>`
        : ''
  }`;
}

export async function initYouTube(S) {
  settingsRef = S;
  const card = $('#card-youtube');
  if (!card) return;
  local.remove(['yt:seen', 'yt:shorts']); // left over from earlier versions
  watched = new Map(Object.entries((await local.get(WATCHED_KEY)) || {}));
  // Marks from other tabs, and Disconnect clearing the list.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[WATCHED_KEY]) return;
    watched = new Map(Object.entries(changes[WATCHED_KEY].newValue || {}));
    render();
  });
  // Opening a video counts as watching it (it leaves the stack the next time it's drawn).
  card.addEventListener('click', (e) => {
    const link = e.target.closest('[data-yt-open]');
    if (!link) return;
    const stays = e.ctrlKey || e.metaKey || e.shiftKey;
    // Opened in another tab, this page stays: take the card out of the stack now.
    setWatched(link.dataset.ytOpen, true).then(() => stays && render());
  });
  card.addEventListener('auxclick', (e) => {
    const link = e.target.closest('[data-yt-open]');
    if (link && e.button === 1) setWatched(link.dataset.ytOpen, true).then(render);
  });
  card.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-yt]');
    if (!b) return;
    const action = b.dataset.yt;
    if (action === 'watched') {
      // The second click of a double-click would land on the next card's eye.
      if (e.detail > 1) return;
      const id = b.dataset.id;
      const hadFocus = document.activeElement === b;
      await setWatched(id, true);
      render();
      if (hadFocus) (card.querySelector('.rolo-card[data-pos="0"] .rolo-watched') || card.querySelector('.rolo'))?.focus();
      showToast('Marked as watched', async () => {
        await setWatched(id, false);
        render();
      });
    } else if (action === 'prev' || action === 'next') {
      flip(action === 'next' ? 1 : -1);
      startFlipping(); // a manual flip restarts the timer
    } else if (action === 'connect' || action === 'retry') {
      state = { ...state, status: 'loading' };
      render();
      try {
        await load({ interactive: action === 'connect', force: true });
      } catch (err) {
        state = { ...state, status: 'error', error: err };
      }
      render();
    }
  });
  // Hovering or focusing the stack holds it still; the wheel and arrow keys flip it.
  card.addEventListener('pointerenter', () => (paused = true));
  card.addEventListener('pointerleave', () => (paused = false));
  card.addEventListener('focusin', () => (paused = true));
  card.addEventListener('focusout', () => (paused = false));
  let wheelAt = 0;
  card.addEventListener(
    'wheel',
    (e) => {
      if (!e.target.closest('.rolo-stack')) return;
      e.preventDefault();
      if (Date.now() - wheelAt < 350) return;
      wheelAt = Date.now();
      flip(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
  card.addEventListener('keydown', (e) => {
    if (!e.target.closest('.rolo') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    flip(e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
    card.querySelector('.rolo-card[data-pos="0"] .rolo-link')?.focus();
  });
  render();
  startFlipping();
}
