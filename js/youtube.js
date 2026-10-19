// New uploads from your YouTube subscriptions. The subscription list comes from the YouTube
// Data API (once a day); new videos come from each channel's public feed, which costs no
// API quota.
import { $, esc, local, relTime, errorText } from './util.js';
import { youtubeApi, googleAccount, googleConfigured } from './gauth.js';
import { icon } from './icons.js';

const SUBS_KEY = 'yt:subs';
const FEED_KEY = 'yt:feed';
const SEEN_KEY = 'yt:seen';
const SHORTS_KEY = 'yt:shorts';
const SUBS_MAX_AGE = 24 * 3600e3;
const FEED_MAX_AGE = 30 * 60e3;
const WINDOW = 7 * 86400e3; // uploads older than a week aren't news
const SHOWN = 8;

let settingsRef;
let state = { status: 'loading', videos: [], error: null, at: 0, failed: 0 };
let seen = { at: 0, opened: [] };
let shorts = {};
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

async function channelUploads(ch) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch.id)}`, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
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
    .filter((v) => v.id && v.at > cutoff)
    .slice(0, 5);
}

// Runs fn over items, a few at a time, so a long subscription list doesn't flood YouTube.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch {
          out[i] = null;
        }
      }
    }),
  );
  return out;
}

async function refreshFeed(subs) {
  const prev = (await local.get(FEED_KEY))?.byChannel || {};
  const results = await pool(subs, 6, channelUploads);
  const byChannel = {};
  // A channel whose feed failed this time keeps what it had.
  subs.forEach((ch, i) => (byChannel[ch.id] = results[i] ?? (prev[ch.id] || []).filter((v) => v.at > Date.now() - WINDOW)));
  const entry = { at: Date.now(), byChannel, failed: results.filter((r) => r === null).length, channels: subs.length };
  await local.set(FEED_KEY, entry);
  return entry;
}

// Shorts answer at youtube.com/shorts/<id>; regular videos redirect from there to /watch.
async function isShort(id) {
  if (id in shorts) return shorts[id];
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(id)}`, { method: 'HEAD', redirect: 'manual', credentials: 'omit' });
    shorts[id] = res.type !== 'opaqueredirect' && res.status === 200;
  } catch {
    shorts[id] = false;
  }
  return shorts[id];
}

async function applyFeed(entry) {
  let videos = Object.values(entry.byChannel || {})
    .flat()
    .sort((a, b) => b.at - a.at);
  if (settingsRef.youtube.hideShorts) {
    const top = videos.slice(0, 40);
    const flags = await pool(top, 6, (v) => isShort(v.id));
    local.set(SHORTS_KEY, Object.fromEntries(Object.entries(shorts).slice(-500)));
    videos = top.filter((_, i) => !flags[i]);
  }
  state = { status: 'ready', videos, error: null, at: entry.at, failed: entry.failed, channels: entry.channels };
}

async function load({ interactive = false, force = false } = {}) {
  const stored = await local.get(FEED_KEY);
  if (stored && !force && Date.now() - stored.at < FEED_MAX_AGE) {
    await applyFeed(stored);
    return;
  }
  if (stored) {
    await applyFeed(stored);
    render();
  }
  const subs = await listSubscriptions({ interactive, force: force && interactive });
  await applyFeed(await refreshFeed(subs));
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
    state.failed ? `<span class="stamp">${state.failed} of ${state.channels} channels didn’t answer</span>` : ''
  }`;
}

export async function initYouTube(S) {
  settingsRef = S;
  const card = $('#card-youtube');
  if (!card) return;
  seen = (await local.get(SEEN_KEY)) || { at: Date.now() - 86400e3, opened: [] };
  shorts = (await local.get(SHORTS_KEY)) || {};
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
