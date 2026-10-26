// Settings → Ticker: what's in the ticker and when, a catalog of extras to add with one click
// (money, tech, sports, music and TV, science, fun, and your own), what the teams, headlines and
// markets cards put in it, and how fast it goes. Writes draft.tickerOptions, each followed team's
// `ticker`, news.ticker and the stocks' ticker choices, calling `changed()` after every edit.
// Other pages change what it lists (cards moved in or out of the ticker, teams followed), so
// the sheet calls the returned paint() whenever it's shown.
import { esc } from './util.js';
import { icon } from './icons.js';
import { TICKER_CARDS, TICKER_EXTRAS, TICKER_SPEEDS, onTicker } from './ticker.js';
import {
  KINDS, SCORE_SHOWS, STANDING_LEVELS, GOLF_TOURS, COINS, CURRENCIES, CHARTS, WIKI_SHOWS, QUAKE_SHOWS, TV_SHOWS, CITIES,
} from './ticker-extras.js';
import { LEAGUES, inTicker } from './teams.js';
import { feedList } from './news.js';
import { stockSymbols } from './stocks.js';
import { NEWS_TOPICS, BUILT_IN_HOSTS } from './settings.js';

// Settings sync through Chrome, which holds at most 8 KB of them; this many extras leaves room.
const MAX_EXTRAS = 16;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SPEED_NAMES = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
const box = (attrs, label, on) => `<label class="check"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;

// ---- The catalog ------------------------------------------------------------------------------

const GROUPS = {
  money: { label: 'Money', icon: 'money' },
  tech: { label: 'Tech', icon: 'chip' },
  sports: { label: 'Sports', icon: 'trophy' },
  culture: { label: 'Music and TV', icon: 'music' },
  world: { label: 'Science and world', icon: 'globe' },
  fun: { label: 'Fun and learning', icon: 'book' },
  yours: { label: 'Your own', icon: 'edit' },
};

const feed = (url, label, more = {}) => ({ kind: 'feed', url, label, ...more });
const search = (query, label) => ({ kind: 'search', query, label });
const nextDate = (month, day) => {
  const now = new Date();
  const year = now.getFullYear() + (new Date(now.getFullYear(), month - 1, day) < new Date().setHours(0, 0, 0, 0) ? 1 : 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// Each: the group it's under, its name and a line about it, and the extra it adds. `again` ones
// can be added more than once (they start empty, to fill in).
const PRESETS = [
  { id: 'crypto', group: 'money', name: 'Crypto prices', about: 'Bitcoin, Ethereum and Solana, with a week’s chart', x: { kind: 'crypto', coins: ['bitcoin', 'ethereum', 'solana'] } },
  { id: 'fx', group: 'money', name: 'Currency rates', about: 'The dollar in euros, pounds, yen, Canadian dollars and pesos', x: { kind: 'fx', base: 'USD', to: ['EUR', 'GBP', 'JPY', 'CAD', 'MXN'] } },
  { id: 'market-news', group: 'money', name: 'Market headlines', about: 'Stock market news from the last two days', x: search('stock market', 'Markets') },
  { id: 'business', group: 'money', name: 'Business news', about: 'Google News’ business stories', x: feed(NEWS_TOPICS.business.url, 'Business') },
  { id: 'cnbc', group: 'money', name: 'CNBC', about: 'Top stories from CNBC', x: feed('https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC') },
  { id: 'money-news', group: 'money', name: 'Personal finance', about: 'Mortgage rates, savings rates and taxes', x: search('mortgage rates OR savings rates OR personal finance', 'Money') },

  { id: 'hn', group: 'tech', name: 'Hacker News', about: 'The front page, most points first', x: { kind: 'hn' } },
  { id: 'tech-news', group: 'tech', name: 'Tech headlines', about: 'Google News’ technology stories', x: feed(NEWS_TOPICS.technology.url, 'Tech') },
  { id: 'ai-news', group: 'tech', name: 'AI news', about: 'Artificial intelligence, from the last two days', x: search('artificial intelligence', 'AI') },
  { id: 'verge', group: 'tech', name: 'The Verge', about: 'Gadgets, apps and the tech business', x: feed('https://www.theverge.com/rss/index.xml', 'The Verge') },
  { id: 'ars', group: 'tech', name: 'Ars Technica', about: 'Tech, science and policy', x: feed('https://feeds.arstechnica.com/arstechnica/index', 'Ars') },
  { id: 'techcrunch', group: 'tech', name: 'TechCrunch', about: 'Startups and the tech industry', x: feed('https://techcrunch.com/feed/', 'TechCrunch') },
  { id: 'wired', group: 'tech', name: 'Wired', about: 'Tech, culture and science', x: feed('https://www.wired.com/feed/rss', 'Wired') },
  { id: 'apps', group: 'tech', name: 'Top iPhone apps', about: 'The App Store’s top free apps', x: { kind: 'charts', chart: 'apps' } },

  { id: 'golf-pga', group: 'sports', name: 'PGA Tour leaderboard', about: 'The top ten this week, with how far they are', x: { kind: 'golf', tour: 'pga', top: 10 } },
  { id: 'golf-lpga', group: 'sports', name: 'LPGA leaderboard', about: 'The top ten on the LPGA Tour', x: { kind: 'golf', tour: 'lpga', top: 10 } },
  { id: 'espn', group: 'sports', name: 'ESPN top headlines', about: 'The biggest stories in sports', x: feed('https://www.espn.com/espn/rss/news', 'ESPN') },
  { id: 'sports-news', group: 'sports', name: 'Sports headlines', about: 'Google News’ sports stories', x: feed(NEWS_TOPICS.sports.url, 'Sports') },

  { id: 'songs', group: 'culture', name: 'Top songs', about: 'Apple Music’s most played, with album art', x: { kind: 'charts', chart: 'songs' } },
  { id: 'albums', group: 'culture', name: 'Top albums', about: 'Apple Music’s most played albums', x: { kind: 'charts', chart: 'albums' } },
  { id: 'podcasts', group: 'culture', name: 'Top podcasts', about: 'Apple Podcasts’ top shows', x: { kind: 'charts', chart: 'podcasts' } },
  { id: 'billboard', group: 'culture', name: 'Billboard', about: 'Music news and the charts', x: feed('https://www.billboard.com/feed/', 'Billboard') },
  { id: 'pitchfork', group: 'culture', name: 'Pitchfork', about: 'Music news and reviews', x: feed('https://pitchfork.com/feed/feed-news/rss', 'Pitchfork') },
  { id: 'rollingstone', group: 'culture', name: 'Rolling Stone', about: 'Music news', x: feed('https://www.rollingstone.com/music/feed/', 'Rolling Stone') },
  { id: 'tv-tonight', group: 'culture', name: 'On TV tonight', about: 'Prime time on the networks, with the time', x: { kind: 'tv', show: 'tonight' } },
  { id: 'streaming', group: 'culture', name: 'New on streaming', about: 'Episodes out today on Netflix, Hulu and the rest', x: { kind: 'tv', show: 'streaming' } },
  { id: 'premieres', group: 'culture', name: 'Season premieres', about: 'New seasons starting today', x: { kind: 'tv', show: 'premieres' } },
  { id: 'movies', group: 'culture', name: 'Top movies', about: 'The most bought movies on iTunes', x: { kind: 'charts', chart: 'movies' } },
  { id: 'books', group: 'culture', name: 'Top books', about: 'Apple Books’ best sellers', x: { kind: 'charts', chart: 'books' } },
  { id: 'variety', group: 'culture', name: 'Variety', about: 'Film, TV and the business of it', x: feed('https://variety.com/feed/', 'Variety') },

  { id: 'launches', group: 'world', name: 'Rocket launches', about: 'What’s going up next, with a countdown', x: { kind: 'launches' } },
  { id: 'quakes', group: 'world', name: 'Earthquakes', about: 'Magnitude 4.5 and up around the world, today', x: { kind: 'quakes', show: 'big' } },
  { id: 'quakes-near', group: 'world', name: 'Earthquakes near you', about: 'Any you might have felt this week', x: { kind: 'quakes', show: 'near', radius: 300 } },
  { id: 'nasa', group: 'world', name: 'NASA', about: 'News from NASA', x: feed('https://www.nasa.gov/news-release/feed/', 'NASA') },
  { id: 'science', group: 'world', name: 'Science headlines', about: 'Google News’ science stories', x: feed(NEWS_TOPICS.science.url, 'Science') },
  { id: 'world', group: 'world', name: 'World headlines', about: 'Google News’ world stories', x: feed(NEWS_TOPICS.world.url, 'World') },
  { id: 'bbc', group: 'world', name: 'BBC World', about: 'World news from the BBC', x: feed('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC') },
  { id: 'npr', group: 'world', name: 'NPR News', about: 'Top stories from NPR', x: feed('https://feeds.npr.org/1001/rss.xml', 'NPR') },

  { id: 'onthisday', group: 'fun', name: 'Today in history', about: 'What happened on this day, from Wikipedia', x: { kind: 'wiki', show: 'onthisday' } },
  { id: 'mostread', group: 'fun', name: 'Trending on Wikipedia', about: 'The most read articles yesterday', x: { kind: 'wiki', show: 'mostread' } },
  { id: 'wiki-news', group: 'fun', name: 'In the news', about: 'Wikipedia’s front-page news', x: { kind: 'wiki', show: 'news' } },
  { id: 'wiki-featured', group: 'fun', name: 'Today’s featured article', about: 'Wikipedia’s pick of the day', x: { kind: 'wiki', show: 'featured' } },
  { id: 'wotd', group: 'fun', name: 'Word of the day', about: 'Merriam-Webster’s, with what it means', x: feed('https://www.merriam-webster.com/wotd/feed/rss2', 'Word of the day', { summary: true }) },
  { id: 'clocks', group: 'fun', name: 'World clocks', about: 'The time and temperature in other cities', x: { kind: 'clocks', zones: ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'] } },
  { id: 'christmas', group: 'fun', name: 'Christmas countdown', about: 'How many days are left', x: () => ({ kind: 'countdown', text: 'Christmas', date: nextDate(12, 25) }) },
  { id: 'newyear', group: 'fun', name: 'New Year countdown', about: 'Days until January 1', x: () => ({ kind: 'countdown', text: 'New Year’s Day', date: nextDate(1, 1) }) },

  { id: 'own-search', group: 'yours', name: 'News search', about: 'The last two days of Google News for any words', again: true, x: search('', '') },
  { id: 'own-feed', group: 'yours', name: 'RSS or Atom feed', about: 'Any site’s feed, like a blog or a podcast', again: true, x: feed('', '') },
  { id: 'own-text', group: 'yours', name: 'A message', about: 'A line of your own, like a reminder', again: true, x: { kind: 'text', text: '' } },
  { id: 'own-countdown', group: 'yours', name: 'A countdown', about: 'Days until a trip, a birthday or a deadline', again: true, x: { kind: 'countdown', text: '', date: '' } },
  { id: 'own-clocks', group: 'yours', name: 'Clocks', about: 'Pick the cities yourself', again: true, x: { kind: 'clocks', zones: [] } },
];

// Leagues with standings worth showing (college conferences are too many for a ticker), and how
// each starts: by division, conference or the whole table.
const STANDING_START = { nfl: 3, nba: 2, wnba: 1, mlb: 3, nhl: 3, mls: 2, nwsl: 1, epl: 1, laliga: 1 };

// ---- Each extra's own settings --------------------------------------------------------------

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

function extraFields(x, i) {
  const at = `data-x-i="${i}"`;
  const field = (key, label, attrs = '') =>
    `<label class="field"><span>${label}</span><input type="text" ${at} data-x-field="${key}" value="${esc(x[key] || '')}" spellcheck="false" autocomplete="off" ${attrs}></label>`;
  const select = (key, label, options, current = x[key]) =>
    `<label class="field"><span>${label}</span><select ${at} data-x-field="${key}">${Object.entries(options).map(([k, l]) => opt(k, l, current)).join('')}</select></label>`;
  const boxes = (key, options) =>
    `<div class="topics">${Object.entries(options).map(([k, l]) => box(`${at} data-x-list="${key}" value="${esc(k)}"`, l, list(x[key]).includes(k))).join('')}</div>`;
  const leagues = Object.fromEntries(Object.entries(LEAGUES).map(([k, l]) => [k, l.label]));
  const tops = (ns) => Object.fromEntries(ns.map((n) => [n, String(n)]));
  switch (x.kind) {
    case 'scores':
      return `<div class="grid2">${select('league', 'League', leagues)}${select('show', 'Show', SCORE_SHOWS)}</div>`;
    case 'sportsnews':
      return `<div class="grid2">${select('league', 'League', leagues)}</div>`;
    case 'standings':
      return `<div class="grid2">${select('league', 'League', Object.fromEntries(Object.keys(STANDING_START).map((k) => [k, LEAGUES[k].label])))}${select('level', 'Grouped', STANDING_LEVELS, x.level || 3)}${select('top', 'Teams from each', tops([3, 4, 5, 6, 8, 10]), x.top || 4)}</div>`;
    case 'golf':
      return `<div class="grid2">${select('tour', 'Tour', GOLF_TOURS)}${select('top', 'Players', tops([5, 10, 15, 20]), x.top || 10)}</div>`;
    case 'crypto':
      return `${boxes('coins', COINS)}<div class="grid2">${select('vs', 'Prices in', { usd: 'US dollars', eur: 'Euros', gbp: 'British pounds', cad: 'Canadian dollars' }, x.vs || 'usd')}</div>`;
    case 'fx':
      return `<div class="grid2">${select('base', 'One of', Object.fromEntries(Object.entries(CURRENCIES).slice(0, 6)), x.base || 'USD')}</div><p class="hint tx-sub">in</p>${boxes('to', CURRENCIES)}`;
    case 'charts':
      return `<div class="grid2">${select('chart', 'Chart', Object.fromEntries(Object.entries(CHARTS).map(([k, c]) => [k, c.label])))}${select('country', 'Country', { us: 'United States', gb: 'United Kingdom', ca: 'Canada', au: 'Australia', ie: 'Ireland' }, x.country || 'us')}</div>`;
    case 'wiki':
      return `<div class="grid2">${select('show', 'Show', WIKI_SHOWS)}</div>`;
    case 'quakes':
      return `<div class="grid2">${select('show', 'Show', QUAKE_SHOWS)}${x.show === 'near' ? select('radius', 'Within', { 100: '100 miles or km', 300: '300 miles or km', 500: '500 miles or km', 1000: '1,000 miles or km' }, x.radius || 300) : ''}</div>${
        x.show === 'near' ? '<p class="hint">Near your weather location, in miles or kilometers as your temperature is in °F or °C.</p>' : ''}`;
    case 'tv':
      return `<div class="grid2">${select('show', 'Show', TV_SHOWS)}${select('country', 'Country', { US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia' }, x.country || 'US')}</div>`;
    case 'search':
      return `<div class="grid2">${field('query', 'Search Google News for', 'placeholder="Buffalo Bills trade"')}${field('label', 'Label', 'placeholder="Shown before each headline"')}</div>`;
    case 'feed':
      return `<div class="grid2">${field('url', 'RSS or Atom feed', 'type="url" placeholder="https://…"')}${field('label', 'Label', 'placeholder="Shown before each headline"')}</div>${box(`${at} data-x-field="summary"`, 'Show the first line of each story instead of when it ran', x.summary)}`;
    case 'text':
      return `${field('text', 'Message', 'placeholder="Trash goes out tonight"')}<div class="grid2">${field('label', 'Label', 'placeholder="Optional"')}${field('url', 'Link', 'type="url" placeholder="Optional"')}</div>`;
    case 'countdown':
      return `<div class="grid2">${field('text', 'Until', 'placeholder="Our trip to Maine"')}<label class="field"><span>On</span><input type="date" ${at} data-x-field="date" value="${esc(x.date || '')}"></label></div>`;
    case 'clocks':
      return `${boxes('zones', Object.fromEntries(Object.entries(CITIES).map(([z, c]) => [z, c[0]])))}${box(`${at} data-x-field="weather"`, 'Show the temperature too', x.weather !== false)}`;
    default:
      return '<p class="hint">Nothing to set: it shows what’s new on its own.</p>';
  }
}

// "Every day", "Weekdays, 9:30 AM–4:00 PM" and the like.
function whenText(when = {}) {
  const days = Array.isArray(when.days) ? [...when.days].sort() : null;
  const dayText = !days
    ? 'Every day'
    : !days.length
      ? 'Never'
      : days.join() === '1,2,3,4,5'
        ? 'Weekdays'
        : days.join() === '0,6'
          ? 'Weekends'
          : days.map((d) => DAYS[d].slice(0, 3)).join(', ');
  const t = (hm) => new Date(`2000-01-01T${hm}`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return when.from && when.to && when.from !== when.to ? `${dayText}, ${t(when.from)}–${t(when.to)}` : dayText;
}

// The days and hours of a card (`card:<key>`) or an extra (`x:<id>`).
function whenEditor(target, when = {}) {
  const days = Array.isArray(when.days) ? when.days : [0, 1, 2, 3, 4, 5, 6];
  const name = target.replace(/\W/g, '-');
  return `<div class="tw" data-tw="${esc(target)}">
    <span class="seg tw-days" role="group" aria-label="Days">${DAYS.map(
      (d, i) => `<label title="${d}"><input type="checkbox" data-tw-day="${i}"${days.includes(i) ? ' checked' : ''} aria-label="${d}"><span>${d.slice(0, 2)}</span></label>`,
    ).join('')}</span>
    <span class="tw-hours"><label class="field inline"><span>From</span><input type="time" id="tw-${name}-from" data-tw-time="from" value="${esc(when.from || '')}"></label>
    <label class="field inline"><span>to</span><input type="time" id="tw-${name}-to" data-tw-time="to" value="${esc(when.to || '')}"></label></span>
    ${days.length ? '' : '<span class="hint tw-never">No days picked: never</span>'}
  </div>`;
}

export function mountTicker(el, draft, changed) {
  const o = () => (draft.tickerOptions ||= { when: {}, extras: [], perCard: 10, speed: 'normal' });
  const extras = () => (o().extras ||= []);
  const whenOf = (target) => {
    if (target.startsWith('card:')) return ((o().when ||= {})[target.slice(5)] ||= {});
    return (extras().find((x) => `x:${x.id}` === target).when ||= {});
  };
  const open = new Set(); // the rows showing their settings
  let group = 'money';
  let league = 'nfl';

  // A row for something in the ticker: its icon and name, when, and its buttons; its settings
  // fold out under Edit.
  const tickerRow = ({ id, iconName, name, when, target, controls = '', body = '' }) => {
    const shown = open.has(id);
    return `<div class="tx-row${shown ? ' open' : ''}">
      <div class="tx-head">
        <span class="tx-icon">${icon(iconName)}</span>
        <span class="tx-name"><strong>${esc(name)}</strong><small class="tx-when">${esc(whenText(when))}</small></span>
        ${controls}
        <button class="btn small tx-edit" type="button" data-tx-open="${esc(id)}" aria-expanded="${shown}">${icon(shown ? 'chevron-down' : 'edit')}${shown ? 'Close' : 'Edit'}</button>
      </div>
      ${shown ? `<div class="tx-body">${body}<h4 class="tx-sub">Days and hours</h4>${whenEditor(target, when)}</div>` : ''}
    </div>`;
  };

  const added = (p) => extras().some((x) => x.preset === p.id);
  const has = (kind, lg) => extras().some((x) => x.kind === kind && x.league === lg);

  const paintCatalog = () => {
    const tabs = `<div class="tabs tx-groups" role="tablist" aria-label="Kinds of extra">${Object.entries(GROUPS)
      .map(([k, g]) => `<button type="button" role="tab" class="tab${k === group ? ' on' : ''}" aria-selected="${k === group}" data-tx-group="${k}">${icon(g.icon)}${esc(g.label)}</button>`)
      .join('')}</div>`;
    const full = extras().length >= MAX_EXTRAS;
    const tile = (p) => {
      const done = !p.again && added(p);
      return `<div class="tx-tile${done ? ' added' : ''}">
        <span class="tx-icon">${icon(TICKER_EXTRAS[(typeof p.x === 'function' ? p.x() : p.x).kind]?.icon || 'star')}</span>
        <span class="tx-tile-text"><strong>${esc(p.name)}</strong><small>${esc(p.about)}</small></span>
        <button class="btn small${done ? '' : ' primary'}" type="button" data-tx-add="${p.id}"${done || full ? ' disabled' : ''}>${done ? 'Added' : `${icon('plus')}Add`}</button>
      </div>`;
    };
    // Sports start with a league and what to show of it.
    const leagueRow =
      group === 'sports'
        ? `<div class="tx-league">
            <label class="field inline"><span>League</span><select data-tx-league>${Object.entries(LEAGUES).map(([k, l]) => opt(k, l.label, league)).join('')}</select></label>
            ${[
              ['scores', 'Live scores'],
              ['sportsnews', 'News'],
              ...(STANDING_START[league] ? [['standings', 'Standings']] : []),
            ]
              .map(([kind, label]) => {
                const done = has(kind, league);
                return `<button class="btn small${done ? '' : ' primary'}" type="button" data-tx-sport="${kind}"${done || full ? ' disabled' : ''}>${done ? `${esc(label)} added` : `${icon('plus')}${esc(label)}`}</button>`;
              })
              .join('')}
          </div>`
        : '';
    return `${tabs}${leagueRow}<div class="tx-tiles">${PRESETS.filter((p) => p.group === group).map(tile).join('')}</div>${
      full ? `<p class="hint">That’s the most extras (${MAX_EXTRAS}). Remove one to add another.</p>` : ''}`;
  };

  const paint = () => {
    const cards = Object.keys(TICKER_CARDS).filter((k) => onTicker(draft, k));
    const teams = draft.teams.list || [];
    const feeds = feedList(draft);
    const symbols = stockSymbols(draft);
    const pickedFeed = (f) => !Array.isArray(draft.news.ticker) || draft.news.ticker.includes(f.id);
    const pickedSym = (s) => !Array.isArray(draft.stocks.ticker) || draft.stocks.ticker.includes(s);
    const n = extras().length;
    el.innerHTML = `
  <section id="set-tkr-now">
    <h3>In the ticker <span class="head-count">${cards.length + n}</span></h3>
    <p class="hint">Cards go in the ticker under <button class="linklike" type="button" data-goto="display">Cards and ticker</button>; extras below are only in the ticker. <strong>Edit</strong> picks days and hours for each (say, Markets on weekdays 9:30–4:00) and an extra’s own settings. The ticker takes turns between them, in this order.</p>
    ${cards.length || n ? '' : '<p class="quiet">Nothing is in the ticker yet. Add an extra below, or put a card in it.</p>'}
    <div class="tx-list">
    ${cards
      .map((k) => tickerRow({ id: `card:${k}`, iconName: TICKER_CARDS[k].icon, name: `${TICKER_CARDS[k].label} card`, when: o().when?.[k], target: `card:${k}` }))
      .join('')}
    ${extras()
      .map((x, i) =>
        tickerRow({
          id: `x:${x.id}`,
          iconName: TICKER_EXTRAS[x.kind]?.icon || 'star',
          name: KINDS[x.kind]?.describe(x) || 'Extra',
          when: x.when,
          target: `x:${x.id}`,
          controls: `<label class="switch" title="On or off"><input type="checkbox" data-x-i="${i}" data-x-field="on"${x.on !== false ? ' checked' : ''} aria-label="On"><span></span></label>
            <button class="icon-btn small" type="button" data-x-move="${i}" data-dir="-1" aria-label="Move up"${i ? '' : ' disabled'}>${icon('chevron-up')}</button>
            <button class="icon-btn small" type="button" data-x-move="${i}" data-dir="1" aria-label="Move down"${i < n - 1 ? '' : ' disabled'}>${icon('chevron-down')}</button>
            <button class="icon-btn small" type="button" data-x-remove="${i}" aria-label="Remove">${icon('close')}</button>`,
          body: extraFields(x, i),
        }),
      )
      .join('')}
    </div>
  </section>
  <section id="set-tkr-extras">
    <h3>Add to the ticker</h3>
    <p class="hint">Extras are only in the ticker, each with its own days and hours. Pick a kind, then <strong>Add</strong>; change it after under <em>In the ticker</em>. Live scores with no game on stay out of the ticker.</p>
    <div class="tx-catalog">${paintCatalog()}</div>
  </section>
  <section id="set-tkr-picks">
    <h3>What the cards put in</h3>
    <p class="hint">Show fewer things in the ticker than on the card. These only matter while the card is in the ticker.</p>
    ${teams.length ? `<h4 class="tkr-sub">Teams</h4><div class="topics">${teams.map((t, i) => box(`data-tkr-team="${i}"`, t.name, inTicker(t))).join('')}</div>` : ''}
    ${feeds.length ? `<h4 class="tkr-sub">Headlines</h4><div class="topics">${feeds.map((f) => box(`data-tkr-feed="${esc(f.id)}"`, f.label, pickedFeed(f))).join('')}</div>` : ''}
    ${symbols.length
      ? `<h4 class="tkr-sub">Markets</h4><div class="topics">${box('data-tkr-indexes', 'The indexes', draft.stocks.tickerIndexes !== false)}${symbols.map((s) => box(`data-tkr-sym="${esc(s)}"`, s, pickedSym(s))).join('')}</div>`
      : ''}
    ${!teams.length && !feeds.length && !symbols.length ? '<p class="quiet">Follow teams, pick headlines or add stocks to choose from them here.</p>' : ''}
  </section>
  <section id="set-tkr-motion">
    <h3>Speed and length</h3>
    <div class="grid2">
      <label class="field"><span>How fast it crawls</span><select data-tkr-opt="speed">${Object.keys(TICKER_SPEEDS).map((k) => opt(k, SPEED_NAMES[k], o().speed || 'normal')).join('')}</select></label>
      <label class="field"><span>Most from each card or extra per turn</span><select data-tkr-opt="perCard" data-type="number">${[3, 5, 10, 15, 20].map((k) => opt(k, String(k), o().perCard || 10)).join('')}</select></label>
    </div>
    <p class="hint">Live scores take up to 24, so a full Sunday fits.</p>
  </section>`;
  };

  // A pick list ticked in full is stored as null, so later topics and symbols start in it.
  const pickList = (attr, all) => {
    const on = [...el.querySelectorAll(`[${attr}]`)].filter((c) => c.checked).map((c) => c.getAttribute(attr));
    return on.length === all.length ? null : on;
  };

  // Typing in a field changes the row's name without drawing the page again (which would lose
  // the cursor); picking from a list or a box redraws, since fields can come and go.
  const rename = (t, x) => {
    const name = t.closest('.tx-row')?.querySelector('.tx-name strong');
    if (name) name.textContent = KINDS[x.kind]?.describe(x) || 'Extra';
  };

  const edit = (e) => {
    const t = e.target;
    const tw = t.closest('[data-tw]');
    if (tw) {
      const when = whenOf(tw.dataset.tw);
      if (t.dataset.twDay) {
        const days = [...tw.querySelectorAll('[data-tw-day]')].filter((c) => c.checked).map((c) => Number(c.dataset.twDay));
        if (days.length === 7) delete when.days;
        else when.days = days;
        tw.querySelector('.tw-never')?.remove();
        if (!days.length) tw.insertAdjacentHTML('beforeend', '<span class="hint tw-never">No days picked: never</span>');
      } else if (t.dataset.twTime) {
        if (t.value) when[t.dataset.twTime] = t.value;
        else delete when[t.dataset.twTime];
      } else return;
      const small = tw.closest('.tx-row')?.querySelector('.tx-when');
      if (small) small.textContent = whenText(when);
    } else if (t.dataset.tkrTeam) {
      const team = draft.teams.list[Number(t.dataset.tkrTeam)];
      if (team) team.ticker = t.checked;
    } else if (t.dataset.tkrFeed) {
      draft.news.ticker = pickList('data-tkr-feed', feedList(draft));
    } else if (t.dataset.tkrSym) {
      draft.stocks.ticker = pickList('data-tkr-sym', stockSymbols(draft));
    } else if (t.matches('[data-tkr-indexes]')) {
      draft.stocks.tickerIndexes = t.checked;
    } else if (t.dataset.xList) {
      const x = extras()[Number(t.dataset.xI)];
      if (!x) return;
      const set = new Set(list(x[t.dataset.xList]));
      if (t.checked) set.add(t.value);
      else set.delete(t.value);
      x[t.dataset.xList] = [...set];
      rename(t, x);
    } else if (t.dataset.xField) {
      const x = extras()[Number(t.dataset.xI)];
      if (!x) return;
      x[t.dataset.xField] = t.type === 'checkbox' ? t.checked : t.tagName === 'SELECT' && /^\d+$/.test(t.value) ? Number(t.value) : t.value.trim();
      rename(t, x);
      if (e.type === 'change' && t.tagName === 'SELECT') {
        changed();
        return paint();
      }
    } else if (t.dataset.tkrOpt) {
      o()[t.dataset.tkrOpt] = t.dataset.type === 'number' ? Number(t.value) : t.value;
    } else if (t.matches('[data-tx-league]')) {
      league = t.value;
      el.querySelector('.tx-catalog').innerHTML = paintCatalog();
      return;
    } else return;
    changed();
  };
  el.addEventListener('input', (e) => e.target.tagName !== 'SELECT' && e.target.type !== 'checkbox' && edit(e));
  el.addEventListener('change', edit);

  // Feeds on other sites need Chrome's OK, asked for while the click still counts as one.
  const allow = (x) => {
    try {
      const u = new URL(x.url || '');
      if (x.kind === 'feed' && !BUILT_IN_HOSTS.includes(u.hostname)) chrome.permissions.request({ origins: [`${u.origin}/*`] }).catch(() => {});
    } catch {}
  };

  const add = (fields, preset) => {
    const x = { id: Date.now().toString(36), on: true, when: {}, ...fields, ...(preset ? { preset } : {}) };
    extras().push(x);
    open.add(`x:${x.id}`);
    return x;
  };

  el.addEventListener('click', (e) => {
    const t = e.target;
    const groupTab = t.closest('[data-tx-group]');
    const preset = t.closest('[data-tx-add]');
    const sport = t.closest('[data-tx-sport]');
    const toggle = t.closest('[data-tx-open]');
    const move = t.closest('[data-x-move]');
    const remove = t.closest('[data-x-remove]');
    let fresh = null;
    if (groupTab) {
      group = groupTab.dataset.txGroup;
      el.querySelector('.tx-catalog').innerHTML = paintCatalog();
      return;
    } else if (toggle) {
      const id = toggle.dataset.txOpen;
      if (open.has(id)) open.delete(id);
      else open.add(id);
      paint();
      el.querySelector(`[data-tx-open="${CSS.escape(id)}"]`)?.focus();
      return;
    } else if (preset) {
      const p = PRESETS.find((q) => q.id === preset.dataset.txAdd);
      if (!p || extras().length >= MAX_EXTRAS) return;
      const fields = structuredClone(typeof p.x === 'function' ? p.x() : p.x);
      allow(fields);
      // Ones you fill in yourself open for that; ready-made ones stay folded.
      fresh = add(fields, p.again ? null : p.id);
      if (!p.again) open.delete(`x:${fresh.id}`);
    } else if (sport) {
      const kind = sport.dataset.txSport;
      fresh = add({ kind, league, ...(kind === 'scores' ? { show: 'live' } : kind === 'standings' ? { level: STANDING_START[league], top: 4 } : {}) });
      open.delete(`x:${fresh.id}`);
    } else if (move) {
      const i = Number(move.dataset.xMove);
      const j = i + Number(move.dataset.dir);
      if (j < 0 || j >= extras().length) return;
      [extras()[i], extras()[j]] = [extras()[j], extras()[i]];
    } else if (remove) {
      extras().splice(Number(remove.dataset.xRemove), 1);
    } else return;
    changed();
    paint();
    if (fresh) {
      const row = el.querySelector(`[data-tx-open="x:${CSS.escape(fresh.id)}"]`)?.closest('.tx-row');
      row?.classList.add('flash');
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (open.has(`x:${fresh.id}`)) row?.querySelector('.tx-body input[type="text"], .tx-body input[type="url"], .tx-body select')?.focus({ preventScroll: true });
    }
  });

  paint();
  return { paint };
}
