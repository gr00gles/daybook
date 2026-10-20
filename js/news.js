import { $, esc, cached, local, relTime, updatedText, errorText, safeUrl } from './util.js';
import { NEWS_TOPICS } from './settings.js';
import { icon } from './icons.js';
import { rolodex } from './rolodex.js';

let feeds = [];
let active = null;
let force = false;
let rolo = null;

async function fetchFeed(url) {
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

export async function refreshNews(S, forceRefresh) {
  feeds = [
    ...S.news.topics.filter((t) => NEWS_TOPICS[t]).map((t) => ({ id: t, ...NEWS_TOPICS[t] })),
    ...S.news.custom.filter((f) => f.url).map((f, i) => ({ id: `custom${i}`, label: f.label || 'Feed', short: f.label || 'Feed', url: f.url })),
  ];
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
