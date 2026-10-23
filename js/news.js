import { $, esc, cached, local, relTime, updatedText, errorText, safeUrl } from './util.js';
import { NEWS_TOPICS } from './settings.js';
import { icon } from './icons.js';
import { rolodex } from './rolodex.js';

let feeds = [];
let active = null;
let force = false;
let rolo = null;

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
      url: link?.getAttribute('href') || link?.textContent?.trim() || '',
      at: Date.parse(get('pubDate') || get('published') || get('updated')) || null,
    };
  });
}

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
      $('#news-updated').textContent = updatedText(meta.at);
      rolo?.stop();
      rolo = null;
      if (!items) {
        body.innerHTML = `<p class="notice warn">${esc(feed.label)}: ${esc(errorText(meta.error))}.</p>`;
        return;
      }
      if (!items.length) {
        body.innerHTML = `<p class="quiet is-empty">No ${esc(feed.label)} headlines right now.</p>`;
        return;
      }
      // A rolodex of headlines, one at a time, rather than a long list.
      body.innerHTML = `<div class="rolo news-rolo" tabindex="0" role="group" aria-roledescription="carousel" aria-label="${esc(feed.label)} headlines">
        <div class="rolo-stack">${items
          .map(
            (n) => `<div class="rolo-card news-card"><a class="rolo-link news-link" href="${esc(safeUrl(n.url))}">
              <span class="news-title">${esc(n.title)}</span>
              <span class="news-meta">${esc(n.source || feed.label)}${n.at ? ` · ${relTime(n.at)}` : ''}</span>
            </a></div>`,
          )
          .join('')}</div>
        ${items.length > 1 ? `<div class="rolo-nav">
          <button class="icon-btn small" type="button" data-rolo="prev" aria-label="Previous headline">${icon('chevron-left')}</button>
          <span class="rolo-pos" aria-live="polite"></span>
          <button class="icon-btn small" type="button" data-rolo="next" aria-label="Next headline">${icon('chevron-right')}</button>
        </div>` : ''}
      </div>${meta.error ? `<p class="notice warn">Couldn't refresh: ${esc(errorText(meta.error))}.</p>` : ''}`;
      rolo = rolodex(body.querySelector('.rolo'));
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
const feedList = (S) => [
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

// ---- Ticker ------------------------------------------------------------------------
// Headlines from every topic in one strip under the top band, taking turns between topics.
// It crawls along on its own and stops while the pointer or focus is on it; the wheel, a
// trackpad or the arrow keys scroll it by hand. With reduced motion it only moves by hand.
// It shares the card's stored feeds, so showing both fetches nothing twice.

const TICKER_MAX = 40;
const SPEED = 42; // pixels a second
const tickerItems = new Map(); // feed id -> its headlines
let tickerFeeds = [];
let paintTimer;
let pos = 0; // where the strip is scrolled to, kept in fractions of a pixel
let held = false;

function tickerList() {
  const lists = tickerFeeds.map((f) => (tickerItems.get(f.id) || []).map((n) => ({ ...n, topic: f.short })));
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < TICKER_MAX && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const n = l[i];
      const key = n?.title.toLowerCase();
      if (!n || seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }
  return out.slice(0, TICKER_MAX);
}

function paintTicker() {
  const items = tickerList();
  const strip = $('#ticker-strip');
  if (!items.length) {
    strip.innerHTML = `<span class="tk-quiet">${tickerFeeds.length ? 'Loading headlines…' : 'Pick a few topics in Settings.'}</span>`;
    return;
  }
  // Two copies, so the strip can wrap around without a gap; the second is out of the tab order.
  const run = (copy) =>
    items
      .map(
        (n) => `<a class="tk-item" href="${esc(safeUrl(n.url))}"${copy ? ' tabindex="-1"' : ''}><span class="tk-topic">${esc(n.topic)}</span><span class="tk-title">${esc(n.title)}</span>${
          n.source ? `<span class="tk-src">${esc(n.source)}${n.at ? ` · ${relTime(n.at)}` : ''}</span>` : ''
        }</a>`,
      )
      .join('');
  strip.innerHTML = `<div class="tk-run">${run(false)}</div><div class="tk-run" aria-hidden="true">${run(true)}</div>`;
  pos = 0;
  strip.scrollLeft = 0;
}

export function refreshTicker(S, force) {
  tickerFeeds = feedList(S);
  if (!tickerFeeds.length) paintTicker();
  for (const feed of tickerFeeds) {
    cached({
      key: `news:${feed.id}`,
      sig: feed.url,
      maxAge: 20 * 60e3,
      force,
      fetch: () => fetchFeed(feed.url),
      render: (items) => {
        if (items) tickerItems.set(feed.id, items);
        clearTimeout(paintTimer);
        paintTimer = setTimeout(paintTicker, 150);
      },
    });
  }
}

export function initTicker() {
  const strip = $('#ticker-strip');
  const box = $('#ticker');
  const hold = (on) => () => (held = on || box.matches(':hover, :focus-within'));
  box.addEventListener('pointerenter', hold(true));
  box.addEventListener('pointerleave', hold(false));
  box.addEventListener('focusin', hold(true));
  box.addEventListener('focusout', () => setTimeout(hold(false)));
  // A wheel that turns up and down scrolls the strip sideways.
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  // Scrolled by hand: carry on from there, wrapping round past the first copy.
  strip.addEventListener('scroll', () => {
    const half = strip.firstElementChild?.offsetWidth || 0;
    if (half && strip.scrollLeft >= half) strip.scrollLeft -= half;
    if (Math.abs(strip.scrollLeft - pos) > 2) pos = strip.scrollLeft;
  });
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let last = 0;
  const step = (t) => {
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    const half = strip.firstElementChild?.offsetWidth || 0;
    if (!held && !still.matches && half > strip.clientWidth / 2) {
      pos += SPEED * dt;
      if (pos >= half) pos -= half;
      strip.scrollLeft = pos;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
