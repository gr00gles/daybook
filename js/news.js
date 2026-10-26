import { $, esc, cached, local, relTime, errorText, safeUrl } from './util.js';
import { NEWS_TOPICS } from './settings.js';
import { icon } from './icons.js';
import { setTicker } from './ticker.js';

let feeds = [];
let active = null;
let force = false;

export async function fetchFeed(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error("That address isn't an RSS or Atom feed");
  return [...xml.querySelectorAll('item, entry')].slice(0, 10).map((it) => {
    const get = (sel) => it.querySelector(sel)?.textContent?.trim() || '';
    const source = get('source');
    let title = get('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = it.querySelector('link');
    return {
      title,
      source,
      // Google News names the source's site, for its icon.
      site: it.querySelector('source')?.getAttribute('url') || '',
      url: link?.getAttribute('href') || link?.textContent?.trim() || '',
      at: Date.parse(get('pubDate') || get('published') || get('updated')) || null,
    };
  });
}

// The source's icon from Chrome's own favicon store, or its first letter.
const siteIcon = (n) =>
  n.site
    ? `<img class="news-fav" src="/_favicon/?${new URLSearchParams({ pageUrl: n.site, size: '32' })}" alt="" width="16" height="16">`
    : `<span class="news-fav letter" aria-hidden="true">${esc((n.source || '•').charAt(0))}</span>`;

function load() {
  const feed = feeds.find((f) => f.id === active);
  if (!feed) return;
  const body = $('#news-body');
  cached({
    key: `news:${feed.id}`,
    sig: feed.url,
    maxAge: 20 * 60e3,
    force,
    fetch: () => fetchFeed(feed.url),
    render: (items, meta) => {
      if (active !== feed.id) return;
      if (!items) {
        body.innerHTML = `<p class="notice warn">${esc(feed.label)}: ${esc(errorText(meta.error))}.</p>`;
        return;
      }
      if (!items.length) {
        body.innerHTML = `<p class="quiet is-empty">No ${esc(feed.label)} headlines right now.</p>`;
        return;
      }
      // The top story large, then the rest as rows, as many as fit (layout.js drops the rest).
      body.innerHTML = `<ol class="news-list">${items
        .map(
          (n, i) => `<li${i ? '' : ' class="news-lead"'}><a class="news-item" href="${esc(safeUrl(n.url))}">
            ${siteIcon(n)}
            <span class="news-title">${esc(n.title)}</span>
            <span class="news-meta">${esc(n.source || feed.label)}${n.at ? ` · ${relTime(n.at)}` : ''}</span>
          </a></li>`,
        )
        .join('')}</ol>${meta.error ? `<p class="notice warn">Couldn't refresh: ${esc(errorText(meta.error))}.</p>` : ''}`;
    },
  });
}

function renderTabs() {
  $('#news-tabs').innerHTML = feeds
    .map(
      (f) =>
        `<button type="button" role="tab" class="tab${f.id === active ? ' on' : ''}" aria-selected="${f.id === active}" data-feed="${esc(f.id)}">${esc(f.short)}</button>`,
    )
    .join('');
}

// The topics picked in Settings, then any feeds added there.
export const feedList = (S) => [
  ...S.news.topics.filter((t) => NEWS_TOPICS[t]).map((t) => ({ id: t, ...NEWS_TOPICS[t] })),
  ...S.news.custom.filter((f) => f.url).map((f, i) => ({ id: `custom${i}`, label: f.label || 'Feed', short: f.label || 'Feed', url: f.url })),
];

export async function refreshNews(S, forceRefresh) {
  feeds = feedList(S);
  if (!feeds.length) {
    $('#news-body').innerHTML = '<p class="quiet is-empty">Pick a few topics in Settings.</p>';
    return;
  }
  if (!active || !feeds.some((f) => f.id === active)) {
    const saved = await local.get('ui:newsTab');
    active = feeds.some((f) => f.id === saved) ? saved : feeds[0].id;
  }
  force = forceRefresh;
  renderTabs();
  load();
}

export function initNews() {
  $('#news-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-feed]');
    if (!tab || tab.dataset.feed === active) return;
    active = tab.dataset.feed;
    local.set('ui:newsTab', active);
    force = false;
    renderTabs();
    load();
  });
}

// ---- In the ticker ---------------------------------------------------------------
// Headlines from every topic, taking turns between topics, led by their news source (a feed
// that doesn't name one goes by its own name). It shares the card's stored feeds, so showing
// both fetches nothing twice.

const tickerItems = new Map(); // feed id -> its headlines
let tickerFeeds = [];

function tickerList() {
  const lists = tickerFeeds.map((f) => (tickerItems.get(f.id) || []).map((n) => ({ ...n, feed: f.label })));
  const seen = new Set();
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const n = l[i];
      const key = n?.title.toLowerCase();
      if (!n || seen.has(key)) continue;
      seen.add(key);
      out.push({ tag: n.source || n.feed, title: n.title, meta: n.at ? relTime(n.at) : '', href: n.url });
    }
  }
  return out;
}

// Settings → Ticker can leave some of the card's feeds out (news.ticker: the feed ids in it).
export function refreshTicker(S, force) {
  tickerFeeds = feedList(S).filter((f) => !Array.isArray(S.news.ticker) || S.news.ticker.includes(f.id));
  if (!tickerFeeds.length) setTicker('news', []);
  for (const feed of tickerFeeds) {
    cached({
      key: `news:${feed.id}`,
      sig: feed.url,
      maxAge: 20 * 60e3,
      force,
      fetch: () => fetchFeed(feed.url),
      render: (items) => {
        if (items) tickerItems.set(feed.id, items);
        setTicker('news', tickerList());
      },
    });
  }
}
