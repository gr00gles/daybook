// New uploads from your YouTube subscriptions. The subscription list comes from the YouTube
// Data API (once a day); new videos come from each channel's public feed, which costs no API
// quota. With Shorts hidden, the feed used is the channel's long-form uploads list (UULF…),
// which leaves out Shorts and live streams.
import { $, esc, local, relTime, errorText } from './util.js';
import { youtubeApi, googleAccount, googleConfigured } from './gauth.js';
import { icon } from './icons.js';

const SUBS_KEY = 'yt:subs';
const FEED_KEY = 'yt:feed';
const SEEN_KEY = 'yt:seen';
const SUBS_MAX_AGE = 24 * 3600e3;
const FEED_MAX_AGE = 15 * 60e3;
// Each refresh checks the channels checked longest ago, at most this many, so a long
// subscription list is spread out instead of hitting YouTube all at once.
const BATCH = 40;
const BACKOFF = 60 * 60e3;
const WINDOW = 7 * 86400e3; // uploads older than a week aren't news
const SHOWN = 8;

let settingsRef;
let state = { status: 'loading', videos: [], error: null, at: 0, failed: 0 };
let seen = { at: 0, opened: [] };
let expanded = false;
let refreshing = null;

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
          if (err instanceof Throttled) throttled = true;
        }
      }
    }),
  );
  return { out, throttled };
}

async function refreshFeed(subs, { all = false } = {}) {
  const prev = (await local.get(FEED_KEY)) || {};
  const mode = settingsRef.youtube.hideShorts ? 'long' : 'all';
  const fresh = prev.mode === mode;
  const byChannel = fresh ? { ...prev.byChannel } : {};
  const checked = fresh ? { ...prev.checked } : {};
  if (!all && prev.pausedUntil > Date.now()) return { ...prev, byChannel, checked };
  const due = [...subs].sort((a, b) => (checked[a.id] || 0) - (checked[b.id] || 0)).slice(0, all ? subs.length : BATCH);
  const { out, throttled } = await pool(due, 4, channelUploads);
  let failed = 0;
  due.forEach((ch, i) => {
    if (out[i] === undefined) return; // skipped after YouTube pushed back
    if (out[i] === null) failed++;
    else byChannel[ch.id] = out[i];
    checked[ch.id] = Date.now();
  });
  // Drop channels you've unsubscribed from, and uploads that have aged out.
  const ids = new Set(subs.map((c) => c.id));
  for (const id of Object.keys(byChannel)) {
    if (!ids.has(id)) delete byChannel[id];
    else byChannel[id] = byChannel[id].filter((v) => v.at > Date.now() - WINDOW);
  }
  const entry = { at: Date.now(), mode, byChannel, checked, failed, channels: subs.length, pausedUntil: throttled ? Date.now() + BACKOFF : 0 };
  await local.set(FEED_KEY, entry);
  return entry;
}

function applyFeed(entry) {
  const videos = Object.values(entry.byChannel || {})
    .flat()
    .sort((a, b) => b.at - a.at);
  state = { status: 'ready', videos, error: null, at: entry.at, failed: entry.failed, channels: entry.channels, paused: entry.pausedUntil > Date.now() };
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

const isNew = (v) => v.at > seen.at && !seen.opened.includes(v.id);

function saveSeen() {
  seen.opened = seen.opened.slice(-300);
  local.set(SEEN_KEY, seen);
}

function render() {
  const body = $('#yt-body');
  if (!body) return;
  const fresh = state.videos.filter(isNew);
  $('#yt-count').textContent = fresh.length ? String(fresh.length) : '';
  $('#yt-updated').textContent = state.at ? `checked ${relTime(state.at) === 'now' ? 'just now' : `${relTime(state.at)} ago`}` : '';
  const foot = $('#yt-foot');

  if (state.status === 'loading') {
    body.innerHTML = '<p class="quiet">Checking your subscriptions…</p>';
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'no-google') {
    body.innerHTML = `<div class="notice setup"><p>Connect Google to see new videos from the YouTube channels you subscribe to.</p><button class="btn small primary" type="button" data-open-settings="accounts">Connect Google</button></div>`;
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'needs-permission') {
    body.innerHTML = `<div class="notice setup"><p><strong>See new uploads from your subscriptions.</strong> Google will ask once for permission to view your YouTube account. Daybook only reads your subscription list.</p><button class="btn small primary" type="button" data-yt="connect">Show my subscriptions</button></div>`;
    foot.innerHTML = '';
    return;
  }
  if (state.status === 'error' && !state.videos.length) {
    body.innerHTML = `<p class="notice warn">YouTube: ${esc(errorText(state.error))}.</p>${state.error?.code === 'needs-google' ? '' : '<button class="btn small" type="button" data-yt="retry">Try again</button>'}`;
    foot.innerHTML = '';
    return;
  }

  const list = expanded ? state.videos.slice(0, 24) : state.videos.slice(0, SHOWN);
  body.innerHTML = list.length
    ? `<ol class="yt-list">${list
        .map(
          (v) => `<li><a class="yt${isNew(v) ? ' new' : ''}" href="https://www.youtube.com/watch?v=${esc(encodeURIComponent(v.id))}" data-yt-open="${esc(v.id)}">
            <img class="yt-thumb" src="https://i.ytimg.com/vi/${esc(encodeURIComponent(v.id))}/mqdefault.jpg" alt="" loading="lazy" width="112" height="63">
            <span class="yt-text">
              <span class="yt-title">${esc(v.title)}</span>
              <span class="yt-meta">${isNew(v) ? '<span class="yt-dot" aria-label="New"></span>' : ''}${esc(v.channel)} · ${relTime(v.at)}</span>
            </span>
          </a></li>`,
        )
        .join('')}</ol>
      ${state.videos.length > SHOWN ? `<button class="linklike yt-more" type="button" data-yt="more">${expanded ? 'Show fewer' : `Show ${Math.min(24, state.videos.length) - SHOWN} more`}</button>` : ''}`
    : '<p class="quiet">No new videos from your subscriptions this week.</p>';
  if (state.error) body.insertAdjacentHTML('beforeend', `<p class="notice warn">Couldn’t refresh: ${esc(errorText(state.error))}.</p>`);
  foot.innerHTML = `${fresh.length ? `<button class="foot-link" type="button" data-yt="seen">${icon('mail-open')}Mark all as seen</button>` : ''}<a class="foot-link" href="https://www.youtube.com/feed/subscriptions">${icon('external')}Subscriptions</a>${
    state.paused
      ? '<span class="stamp">YouTube asked Daybook to slow down; checking again within the hour</span>'
      : state.failed
        ? `<span class="stamp">${state.failed} channel${state.failed === 1 ? '' : 's'} didn’t answer</span>`
        : ''
  }`;
}

export async function initYouTube(S) {
  settingsRef = S;
  const card = $('#card-youtube');
  if (!card) return;
  seen = (await local.get(SEEN_KEY)) || { at: Date.now() - 86400e3, opened: [] };
  card.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-yt-open]');
    if (open) {
      seen.opened.push(open.dataset.ytOpen);
      saveSeen();
      return;
    }
    const b = e.target.closest('[data-yt]');
    if (!b) return;
    const action = b.dataset.yt;
    if (action === 'more') {
      expanded = !expanded;
      render();
    } else if (action === 'seen') {
      seen = { at: Date.now(), opened: [] };
      saveSeen();
      render();
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
  render();
}
