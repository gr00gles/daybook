// The Settings sheet: a page for each part of Daybook, picked from the list down the side (grouped
// into layout, the cards, and you), and a search box that looks through all of them, marking what
// it finds. Cards and ticker, the first page, has a tile for every card and part of the top bar:
// where it shows (on the page, in the ticker, both, in the flip card or not at all), a line about
// how it's set up, and a way to its own page. Each page starts with the same choice. Every change
// saves as you make it; closing the sheet reloads the page so each card picks up the new settings.
import { $, $$, esc } from './util.js';
import { saveSettings, NEWS_TOPICS, ENGINES } from './settings.js';
import { extraOrigins } from './calendar.js';
import { mountGoogle, mountGmail, mountOutlook, mountLocation, mountShippingFolders } from './setup-ui.js';
import { holidayChoices } from './sky.js';
import { icon, hasIcon } from './icons.js';
import { groupList, openGroupEditor } from './sites.js';
import { mountTeams } from './teams.js';
import { loadAi, saveAi, CLAUDE_MODELS, aiSignIns } from './ask.js';
import { AREA_KINDS } from './area.js';
import { mountJobs, ruleCount } from './jobs.js';
import { TICKER_CARDS, TICKER_EXTRAS, tickerMode, tickerModes, onTicker } from './ticker.js';
import { mountTracking } from './tracking.js';
import { mountTicker } from './ticker-settings.js';
import { feedList } from './news.js';
import { stockSymbols, MAX_SYMBOLS, INDEXES, POPULAR } from './stocks.js';

let draft;
let aiDraft;
let dirty = false;
let saveTimer;
let page = 'display'; // the page shown, kept between openings
let query = '';
let tickerPage; // the Ticker page, repainted when shown since other pages change what it lists

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];
const COLOR_NAMES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Magenta', 'Green', 'Violet', 'Red'];

const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
const check = (path, label, on) =>
  `<label class="check"><input type="checkbox" data-path="${path}"${on ? ' checked' : ''}><span>${label}</span></label>`;
// More about a setting, folded away until asked for. Searching opens the ones it finds words in.
const more = (html, summary = 'More about this') => `<details class="more"><summary>${summary}</summary>${html}</details>`;

function colorSelect(attrs, current) {
  return `<span class="swatch-wrap"><span class="cal-dot" style="--c: var(--cat-${current})"></span><select class="swatch" ${attrs} aria-label="Color">${COLORS.map((c) => opt(c, COLOR_NAMES[c - 1], current)).join('')}</select></span>`;
}

// The pages, in the order of the list down the side, under their group's heading; `show` names
// the cards and parts of the top bar each one sets up.
const GROUPS = { start: '', layout: 'Layout', cards: 'Cards', you: 'You' };
const PAGES = {
  display: { label: 'Cards and ticker', icon: 'eye', group: 'start', about: 'Where each card and each part of the top bar shows. Pick one to change it, or open its own settings.' },
  ticker: { label: 'Ticker', icon: 'ticker', group: 'layout', about: 'The bar under the top band that crawls through the latest from everything you put in it: cards, and extras like live scores, crypto, charts and more.' },
  flip: { label: 'Flip card', icon: 'refresh', group: 'layout', about: 'One spot on the board where several cards take turns.' },
  calendar: { label: 'Calendar', icon: 'clock', group: 'cards', show: ['today', 'month', 'holidays'], about: 'Today, the month, holidays, calendars by link, and when to leave for events.' },
  mail: { label: 'Mail and deliveries', icon: 'mail', group: 'cards', show: ['mail', 'deliveries'], about: 'Unread Gmail and Outlook, and packages on their way.' },
  weather: { label: 'Weather', icon: 'drop', group: 'cards', show: ['weather', 'alerts'], about: 'Today’s weather in the top bar, the week when you click it, and severe weather alerts.' },
  stocks: { label: 'Markets', icon: 'money', group: 'cards', show: ['stocks'], about: 'Your watchlist with a chart for each, the indexes, and how they’ve done today or over a year.' },
  jobs: { label: 'NYS jobs', icon: 'building', group: 'cards', show: ['jobs'], about: 'New vacancies from StateJobsNY that match your search.' },
  teams: { label: 'Teams', icon: 'star', group: 'cards', show: ['teams'], about: 'Next games, live scores and news for the teams you follow.' },
  news: { label: 'Headlines', icon: 'globe', group: 'cards', show: ['news'], about: 'Headlines by topic, and feeds of your own.' },
  area: { label: 'Around you', icon: 'pin', group: 'cards', show: ['area'], about: 'Concerts, shows, festivals and games near you.' },
  youtube: { label: 'YouTube', icon: 'video', group: 'cards', show: ['youtube'], about: 'New uploads from the channels you subscribe to.' },
  shortcuts: { label: 'Shortcuts and notes', icon: 'link', group: 'cards', show: ['shortcuts', 'notes'], about: 'Groups of sites, your most visited sites, and the notes card.' },
  general: { label: 'General', icon: 'gear', group: 'you', about: 'Your name, the theme, the clock and temperature units, and backups of your settings.' },
  accounts: { label: 'Accounts', icon: 'person', group: 'you', about: 'Google Calendar, Gmail and Outlook.' },
  search: { label: 'Search and AI', icon: 'search', group: 'you', about: 'The search box, and answers from Claude, ChatGPT and Gemini.' },
};
const pageOf = (key) => Object.keys(PAGES).find((id) => PAGES[id].show?.includes(key));
const pageAttr = (id) => (id === page || query ? '' : ' hidden');

// ---- How each card is set up ----------------------------------------------------------------

// A line about how a card or part of the top bar is set up, and whether it needs something
// before it can show anything (`warn`).
function statusOf(key) {
  const d = draft;
  const symbols = stockSymbols(d);
  const feeds = feedList(d);
  switch (key) {
    case 'weather':
      return { text: d.location.mode === 'manual' && d.location.name ? d.location.name : 'Where you are' };
    case 'alerts':
      return { text: 'From the National Weather Service' };
    case 'holidays':
      return { text: 'The moon, and the coming holidays' };
    case 'shortcuts':
      return { text: 'Your most visited sites' };
    case 'deliveries':
      return { text: d.packages.tracked.length ? `From shipping emails, and ${d.packages.tracked.length} by hand` : 'From shipping emails' };
    case 'news':
      return feeds.length ? { text: feeds.map((f) => f.short).join(', ') } : { text: 'No topics picked', warn: true };
    case 'stocks':
      return symbols.length ? { text: symbols.join(', ') } : { text: 'No symbols yet', warn: true };
    case 'teams':
      return d.teams.list.length ? { text: d.teams.list.map((t) => t.short || t.name).join(', ') } : { text: 'No teams followed yet', warn: true };
    case 'area':
      return d.area.key ? { text: `Within ${d.area.radius} ${d.units === 'C' ? 'km' : 'miles'}` } : { text: 'Needs a Ticketmaster key', warn: true };
    case 'jobs': {
      const n = ruleCount(d.jobs);
      return { text: n ? `${n} ${n === 1 ? 'option or rule' : 'options and rules'}` : 'Every new posting' };
    }
    case 'youtube':
      return { text: d.youtube.hideShorts ? 'Shorts hidden' : 'Shorts shown' };
    case 'notes':
      return { text: 'Syncs with your Chrome profile' };
    default:
      return { text: '' };
  }
}
const isOff = (key) => tickerMode(draft, key) === 'off';
const needs = () => Object.keys(TICKER_CARDS).filter((k) => !isOff(k) && statusOf(k).warn);

const MODE_NAMES = (c) => ({ card: c.board, both: `${c.board} + ticker`, ticker: 'Ticker only', flip: 'Flip card', off: 'Off' });

// Where one card or part of the top bar shows, as the row of choices at the top of its page.
function display(key) {
  const c = TICKER_CARDS[key];
  const mode = tickerMode(draft, key);
  const names = MODE_NAMES(c);
  return `<div class="disp${mode === 'off' ? ' is-off' : ''}" data-disp="${key}">
    <span class="disp-name">${icon(c.icon)}<span>${esc(c.label)}</span></span>
    <span class="seg disp-seg" role="radiogroup" aria-label="Where ${esc(c.label)} shows">${tickerModes(key)
      .map((m) => `<label><input type="radio" name="disp-${key}" value="${m}" data-display="${key}"${m === mode ? ' checked' : ''}><span>${esc(names[m])}</span></label>`)
      .join('')}</span>
  </div>`;
}

const showBlock = (id) => `<section id="set-show-${id}" class="set-show">
    <h3>Where it shows</h3>
    ${PAGES[id].show.map((k) => display(k)).join('')}
  </section>`;

// A tile on Cards and ticker: the card, how it's set up, where it shows, and its page.
function tile(key) {
  const c = TICKER_CARDS[key];
  const mode = tickerMode(draft, key);
  const s = statusOf(key);
  const names = MODE_NAMES(c);
  return `<div class="ov-tile${mode === 'off' ? ' is-off' : ''}${s.warn && mode !== 'off' ? ' warn' : ''}" data-disp="${key}">
    <span class="tx-icon">${icon(c.icon)}</span>
    <span class="ov-text"><strong>${esc(c.label)}</strong><small class="ov-status">${esc(s.text)}</small></span>
    <select data-display="${key}" aria-label="Where ${esc(c.label)} shows">${tickerModes(key).map((m) => opt(m, names[m], mode)).join('')}</select>
    <button class="icon-btn small ov-go" type="button" data-goto="${pageOf(key)}" title="${esc(c.label)} settings" aria-label="${esc(c.label)} settings">${icon('chevron-right')}</button>
  </div>`;
}

function attention() {
  const list = needs();
  if (!list.length) return '';
  return `<div class="notice warn ov-needs"><p><strong>${list.length === 1 ? 'One thing needs' : `${list.length} things need`} setting up</strong></p><ul>${list
    .map((k) => `<li><strong>${esc(TICKER_CARDS[k].label)}</strong>: ${esc(statusOf(k).text)}. <button class="linklike" type="button" data-goto="${pageOf(k)}">Set it up</button></li>`)
    .join('')}</ul></div>`;
}

function overview() {
  const keys = Object.keys(TICKER_CARDS);
  const group = (board) => keys.filter((k) => TICKER_CARDS[k].board === board).map(tile).join('');
  const inTicker = keys.filter((k) => onTicker(draft, k)).length + (draft.tickerOptions?.extras || []).filter((x) => x.on !== false).length;
  const inFlip = keys.filter((k) => tickerMode(draft, k) === 'flip').length;
  return `<section id="set-overview">
    <div id="ov-needs">${attention()}</div>
    <div class="ov-summary">
      <button class="ov-chip" type="button" data-goto="ticker">${icon('ticker')}<span><strong id="ov-ticker-n">${inTicker}</strong> in the ticker</span>${icon('chevron-right')}</button>
      <button class="ov-chip" type="button" data-goto="flip">${icon('refresh')}<span><strong id="ov-flip-n">${inFlip}</strong> in the flip card</span>${icon('chevron-right')}</button>
    </div>
  </section>
  <section id="set-cards">
    <h3>Cards</h3>
    <div class="ov-tiles">${group('Card')}</div>
  </section>
  <section id="set-sections">
    <h3>Top bar</h3>
    <div class="ov-tiles">${group('Top bar')}</div>
    ${more('<p class="hint">Each can be on the page, in the ticker as well (<strong>+ ticker</strong>), in the ticker instead, in the flip card (cards only), or off. The ticker is a bar under the top band that crawls through the latest from everything in it, taking turns: hover over it to hold it still, scroll it to look along it, and click anything to open it.</p>', 'What the choices mean')}
  </section>`;
}

// The flip card's own page: which cards take turns in it, and how often it turns.
function flipPage() {
  const keys = Object.keys(TICKER_CARDS).filter((k) => tickerModes(k).includes('flip'));
  return `<section id="set-flip">
    <h3>Cards in it</h3>
    <div class="topics">${keys
      .map((k) => `<label class="check"><input type="checkbox" data-flip-pick="${k}"${tickerMode(draft, k) === 'flip' ? ' checked' : ''}><span>${esc(TICKER_CARDS[k].label)}</span></label>`)
      .join('')}</div>
    <label class="field inline"><span>Turn to the next</span><select id="s-flip-every" data-path="flip.every" data-type="number">${[[10, 'Every 10 seconds'], [20, 'Every 20 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute'], [0, 'Only when I pick one']].map(([n, l]) => opt(n, l, draft.flip.every)).join('')}</select></label>
    ${more('<p class="hint">Ticked cards leave their own spots and share one card on the board, taking turns: it turns over to the next every so often, and the tabs along its top pick one by hand. It holds still while the pointer or the keyboard is on it. Move it like any card with <strong>Arrange cards</strong>. With nothing ticked, there’s no flip card.</p>', 'How it works')}
  </section>`;
}

// The list down the side, with a word on each page where it helps: Off, a count, or a dot when
// something needs setting up.
function navBadge(id) {
  const p = PAGES[id];
  if (id === 'ticker') {
    const n = Object.keys(TICKER_CARDS).filter((k) => onTicker(draft, k)).length + (draft.tickerOptions?.extras || []).filter((x) => x.on !== false && TICKER_EXTRAS[x.kind]).length;
    return n ? `<span class="nav-n">${n}</span>` : '';
  }
  if (id === 'flip') {
    const n = Object.keys(TICKER_CARDS).filter((k) => tickerMode(draft, k) === 'flip').length;
    return n ? `<span class="nav-n">${n}</span>` : '';
  }
  if (!p.show) return '';
  if (p.show.every(isOff)) return '<span class="nav-off">Off</span>';
  const warn = p.show.find((k) => !isOff(k) && statusOf(k).warn);
  return warn ? `<span class="nav-warn" title="${esc(statusOf(warn).text)}"></span>` : '';
}

function navHtml() {
  let html = '';
  let last = null;
  for (const [id, p] of Object.entries(PAGES)) {
    if (p.group !== last) {
      last = p.group;
      if (GROUPS[p.group]) html += `<p class="nav-group">${esc(GROUPS[p.group])}</p>`;
    }
    html += `<button type="button" data-goto="${id}"${id === page && !query ? ' aria-current="page"' : ''}>${icon(p.icon)}<span class="nav-label">${esc(p.label)}</span>${navBadge(id)}</button>`;
  }
  return html;
}

const head = (id) => `<header class="page-head"><h2 class="page-title">${icon(PAGES[id].icon)}${esc(PAGES[id].label)}</h2><p class="page-about">${esc(PAGES[id].about)}</p></header>`;

function build() {
  const d = draft;
  return `<form method="dialog" class="sheet-inner" id="settings-form" novalidate>
  <header class="sheet-head">
    <h2>Settings</h2>
    <label class="sheet-find">${icon('search')}<input id="set-q" type="search" placeholder="Search settings" value="${esc(query)}" autocomplete="off" spellcheck="false" aria-label="Search settings" aria-keyshortcuts="/ Control+F" title="Press / to search"><span class="set-count" id="set-count" aria-live="polite"></span></label>
    <button class="icon-btn" type="submit" value="done" aria-label="Close settings">${icon('close')}</button>
  </header>

  <div class="sheet-body">
  <nav class="sheet-nav" aria-label="Settings pages">${navHtml()}</nav>
  <div class="sheet-pages">
  <div class="set-page" data-page="display"${pageAttr('display')}>
    ${head('display')}
${overview()}
  </div>
  <div class="set-page" data-page="ticker"${pageAttr('ticker')}>
    ${head('ticker')}
    <div id="sheet-ticker"></div>
  </div>
  <div class="set-page" data-page="flip"${pageAttr('flip')}>
    ${head('flip')}
${flipPage()}
  </div>
  <div class="set-page" data-page="calendar"${pageAttr('calendar')}>
    ${head('calendar')}
${showBlock('calendar')}
  <section id="set-calendars">
    <h3>Calendars by link</h3>
    <p class="hint">Google and Outlook calendars come from <button class="linklike" type="button" data-goto="accounts">Accounts</button>. Add any other calendar that has an iCal (.ics) link: a sports schedule, a school calendar, an iCloud calendar shared publicly. Treat private links like passwords.</p>
    ${d.calendars
      .map(
        (c, i) => `<div class="cal-row">
        <div class="row">
          ${colorSelect(`id="s-cal-${i}-color" data-list="calendars" data-i="${i}" data-field="color" data-type="number"`, c.color)}
          <label class="field"><span>Name</span><input id="s-cal-${i}-name" type="text" data-list="calendars" data-i="${i}" data-field="name" value="${esc(c.name)}"></label>
          <label class="check small"><input id="s-cal-${i}-on" type="checkbox" data-list="calendars" data-i="${i}" data-field="enabled"${c.enabled ? ' checked' : ''}><span>Show</span></label>
          <button class="icon-btn" type="button" data-action="remove" data-list="calendars" data-i="${i}" aria-label="Remove ${esc(c.name)}">${icon('close')}</button>
        </div>
        <label class="field"><span>iCal link (.ics)</span><input id="s-cal-${i}-url" type="url" data-list="calendars" data-i="${i}" data-field="url" value="${esc(c.url)}" placeholder="https://…/calendar.ics" spellcheck="false"></label>
      </div>`,
      )
      .join('')}
    <button class="btn small" type="button" data-action="add-calendar">${icon('plus')}Add a calendar link</button>
    ${more('<p class="hint">An Outlook calendar can be published from Outlook.com (Settings → Calendar → Shared calendars → <em>Publish a calendar</em>) and added here by its link, if you’d rather not sign in.</p>')}
  </section>
  <section id="set-holidays">
    <h3>Holidays</h3>
    <p class="hint">Holidays to show under the date and on the month, each with its own colors and emblem.</p>
    <div class="topics hol-choices" id="sheet-holidays"><p class="quiet">Loading holidays…</p></div>
  </section>
  <section id="set-travel">
    <h3>Travel time</h3>
    <div class="trk-mail">${check('show.travel', 'Show travel time and the weather at events with an address', d.show.travel)}</div>
    <div class="grid2">
      <label class="field"><span>Extra time before leaving</span><select id="s-buffer" data-path="travel.buffer" data-type="number">${[0, 5, 10, 15, 20, 30].map((m) => opt(m, m ? `${m} minutes` : 'None', d.travel.buffer)).join('')}</select></label>
      <label class="field"><span>TomTom key for live traffic (optional)</span><input id="s-tomtom" type="text" data-path="travel.tomtomKey" value="${esc(d.travel.tomtomKey)}" placeholder="Paste your TomTom API key" spellcheck="false" autocomplete="off"></label>
    </div>
    ${more('<p class="hint">For events with an address, Daybook shows the weather there and, for the next 24 hours, when to leave from where you are. Addresses are looked up with Photon (OpenStreetMap), and drive times come from OSRM, which doesn’t know about traffic. For traffic, sign up free at <a href="https://developer.tomtom.com/" target="_blank" rel="noopener">developer.tomtom.com</a> and copy the key from your dashboard.</p>')}
  </section>
  </div>
  <div class="set-page" data-page="mail"${pageAttr('mail')}>
    ${head('mail')}
${showBlock('mail')}
  <p class="hint set-note">Which inboxes and folders show unread mail is under <button class="linklike" type="button" data-goto="accounts">Accounts</button>.</p>
  <section id="set-packages">
    <h3>Package tracking</h3>
    <p class="hint">Deliveries finds packages in your shipping emails and follows each one on the carrier’s own site.</p>
    <div class="trk-mail">${check('packages.fromMail', 'Find packages in shipping emails', d.packages.fromMail)}</div>
    <div class="trk-mail">${check('packages.checkSites', 'Check carriers’ tracking pages for the latest status', d.packages.checkSites)}</div>
    <div class="trk-mail">${check('packages.amazonPages', 'Read what’s in Amazon packages from their order pages', d.packages.amazonPages)}</div>
    ${more(`<p class="hint">Daybook reads your shipping emails from the last two weeks in full, read or not, for the tracking number, the delivery day and what’s in the box: Gmail through Gmail’s own page with the sign-in already in Chrome (no setup, nothing changed in your mailbox), Outlook through its sign-in under Accounts. It also follows each package on the carrier’s site, free and without a key: it opens the tracking page at UPS, USPS, FedEx, DHL or Amazon out of sight and reads the status and delivery day off it, every couple of hours while a new tab is open. When a page can’t be read, the newest email about the package stands in.</p>
    <p class="hint">Amazon’s shipping emails name only a category, like “Boating Accessories”. With the Amazon box ticked, Daybook opens each order’s page on amazon.com out of sight, signed in the way you are in this browser, and takes the item names from it, once an order. Nothing on your account changes.</p>
    <p class="hint">To hear about every package coming to your address without entering anything, sign up (free) for <a href="https://www.ups.com/us/en/services/tracking/mychoice" target="_blank" rel="noopener">UPS My Choice</a>, <a href="https://www.fedex.com/en-us/delivery-manager.html" target="_blank" rel="noopener">FedEx Delivery Manager</a> and <a href="https://informeddelivery.usps.com/" target="_blank" rel="noopener">USPS Informed Delivery</a>: they email you as each one moves, and Daybook reads those emails.</p>`, 'How tracking works')}
    <h4>Where to look for shipping emails</h4>
    <div id="sheet-ship-folders"></div>
    <h4>Packages you’re tracking</h4>
    <div id="sheet-tracking"></div>
  </section>
  </div>
  <div class="set-page" data-page="weather"${pageAttr('weather')}>
    ${head('weather')}
${showBlock('weather')}
  <section id="set-location">
    <h3>Weather location</h3>
    <div id="sheet-location"></div>
  </section>
  </div>
  <div class="set-page" data-page="stocks"${pageAttr('stocks')}>
    ${head('stocks')}
${showBlock('stocks')}
  <section id="set-stocks">
    <h3>Your watchlist</h3>
    <p class="hint">Up to ${MAX_SYMBOLS} stocks, funds or other symbols, as Yahoo Finance writes them (BRK-B, ^GSPC, BTC-USD). Four show with their names and a chart for each; five to eight in two columns. The tabs on the card show the day, 5 days, a month, 6 months or a year.</p>
    <div id="sheet-symbols"></div>
  </section>
  <section id="set-indexes">
    <h3>Along the top of the card</h3>
    <div class="topics">${Object.entries(INDEXES)
      .map(([k, l]) => `<label class="check"><input type="checkbox" data-index="${esc(k)}"${(d.stocks.indexes || []).includes(k) ? ' checked' : ''}><span>${esc(l)}</span></label>`)
      .join('')}</div>
  </section>
  <section id="set-finnhub">
    <h3>Finnhub key (optional)</h3>
    <label class="field"><span>Finnhub API key</span><input id="s-finnhub" type="text" data-path="stocks.key" value="${esc(d.stocks.key)}" placeholder="Paste your Finnhub API key" spellcheck="false" autocomplete="off"></label>
    ${more('<p class="hint">Quotes and charts come from Yahoo Finance and need no key. A free Finnhub key (sign up at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a>) stands in for today’s quotes when Yahoo can’t be reached, and lets the card tell market holidays apart. Quotes refresh every 5 minutes while the US market is open; click a row to open it on Yahoo Finance.</p>')}
  </section>
  </div>
  <div class="set-page" data-page="jobs"${pageAttr('jobs')}>
    ${head('jobs')}
${showBlock('jobs')}
  <section id="set-jobs-alerts">
    <h3>Getting your attention</h3>
    <div class="trk-mail">${check('jobs.glow', 'Ring the card in green when a new posting matches, until you look at it', d.jobs.glow !== false)}</div>
    <label class="field inline"><span>In the search bar, show postings I haven’t reviewed that close</span><select id="s-jobs-due" data-path="jobs.dueSoon" data-type="number">${[[0, 'Never'], [3, 'Within 3 days'], [7, 'Within a week'], [14, 'Within two weeks']].map(([n, l]) => opt(n, l, d.jobs.dueSoon ?? 7)).join('')}</select></label>
    ${more('<p class="hint">A posting is new from when Daybook first sees it on StateJobsNY. The green ring goes once the pointer rests on the card for a moment, or you click in it; new postings keep a <strong>New</strong> tag for a day. Postings that close soon take turns in the bubble at the end of the search bar, soonest first, red for today and tomorrow; the eye there marks one as reviewed. They come from the last two weeks of postings that pass your search and rules, whatever days the card shows.</p>')}
  </section>
  <section id="set-jobs">
    <h3>Search and rules</h3>
    <p class="hint">The options of <a href="https://statejobs.ny.gov/public/search.cfm" target="_blank" rel="noopener">StateJobsNY</a>’s own search, then rules of your own. The card shows the postings that match all of the ones you set.</p>
    <div id="sheet-jobs"></div>
  </section>
  </div>
  <div class="set-page" data-page="teams"${pageAttr('teams')}>
    ${head('teams')}
${showBlock('teams')}
  <section id="set-teams">
    <h3>Teams you follow</h3>
    <div id="sheet-teams"></div>
    <div class="topics">
      ${check('teams.calendar', 'Show games on the calendar', d.teams.calendar)}
      ${check('teams.news', 'Show team news', d.teams.news)}
      ${check('teams.wins', 'Show the last score in the search bar for a day', d.teams.wins)}
    </div>
    ${more('<p class="hint">The card has each team’s next game (and the score while it’s on), and recent team news; their games go on your calendar with the team’s logo. For a day after a game, the two logos and the score take a turn in the bubble at the end of the search bar, green for a win and red for a loss. Untick a team’s Card box to leave it off the card (its games stay on the calendar), or its News box to leave it out of the news. Schedules come from ESPN; news from Google News. Whole leagues’ scores, news and standings can go in the <button class="linklike" type="button" data-goto="ticker">ticker</button>.</p>')}
  </section>
  </div>
  <div class="set-page" data-page="news"${pageAttr('news')}>
    ${head('news')}
${showBlock('news')}
  <section id="set-news">
    <h3>Topics</h3>
    <div class="topics">${Object.entries(NEWS_TOPICS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-topic="${k}"${d.news.topics.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
    <h4>Feeds of your own</h4>
    ${d.news.custom
      .map(
        (f, i) => `<div class="row">
        <label class="field narrow"><span>Label</span><input id="s-feed-${i}-label" type="text" data-list="news.custom" data-i="${i}" data-field="label" value="${esc(f.label)}"></label>
        <label class="field"><span>RSS or Atom feed</span><input id="s-feed-${i}-url" type="url" data-list="news.custom" data-i="${i}" data-field="url" value="${esc(f.url)}" spellcheck="false"></label>
        <button class="icon-btn" type="button" data-action="remove" data-list="news.custom" data-i="${i}" aria-label="Remove feed">${icon('close')}</button>
      </div>`,
      )
      .join('')}
    <button class="btn small" type="button" data-action="add-feed">${icon('plus')}Add a feed</button>
  </section>
  </div>
  <div class="set-page" data-page="area"${pageAttr('area')}>
    ${head('area')}
${showBlock('area')}
  <section id="set-area">
    <h3>Area events</h3>
    <label class="field"><span>Ticketmaster key</span><input id="s-ticketmaster" type="text" data-path="area.key" value="${esc(d.area.key)}" placeholder="Paste your Ticketmaster Consumer Key" spellcheck="false" autocomplete="off"></label>
    <p class="hint">Get one free: sign up at <a href="https://developer-acct.ticketmaster.com/user/register" target="_blank" rel="noopener">developer.ticketmaster.com</a>, open <strong>My Apps</strong> and copy the <strong>Consumer Key</strong>.</p>
    <div class="grid2">
      <label class="field"><span>How far</span><select id="s-area-radius" data-path="area.radius" data-type="number">${[10, 25, 50, 100].map((r) => opt(r, `Within ${r} ${d.units === 'C' ? 'km' : 'miles'}`, d.area.radius)).join('')}</select></label>
      <label class="field"><span>How far ahead</span><select id="s-area-days" data-path="area.days" data-type="number">${[[7, 'The next week'], [14, 'The next two weeks'], [30, 'The next month']].map(([n, l]) => opt(n, l, d.area.days)).join('')}</select></label>
    </div>
    <div class="topics">${Object.entries(AREA_KINDS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-area-kind="${k}"${d.area.kinds.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
    ${more('<p class="hint">Concerts, shows, festivals and games around your weather location, from Ticketmaster. Brewery nights and other small local events are rarely on Ticketmaster, so the card also has quick searches for those.</p>')}
  </section>
  </div>
  <div class="set-page" data-page="youtube"${pageAttr('youtube')}>
    ${head('youtube')}
${showBlock('youtube')}
  <section id="set-youtube">
    <h3>Uploads</h3>
    <p class="hint">New uploads from the channels you subscribe to, from the last week, with the YouTube sign-in already in Chrome.</p>
    ${check('youtube.hideShorts', 'Hide Shorts', d.youtube.hideShorts)}
  </section>
  </div>
  <div class="set-page" data-page="shortcuts"${pageAttr('shortcuts')}>
    ${head('shortcuts')}
${showBlock('shortcuts')}
  <section id="set-sites">
    <h3>Site groups</h3>
    <p class="hint">Groups sit at the start of the shortcuts row. Hover over one to see its sites; <strong>Edit</strong> at the end changes it.</p>
    <div class="trk-mail">${check('show.companies', 'Show your companies in the shortcuts', d.show.companies)}</div>
    <div class="group-rows" id="sheet-groups"></div>
    <button class="btn small" type="button" data-action="add-group">${icon('plus')}Add a group</button>
    <p class="hint small">Your companies have their own pages: <a href="companies.html">open Companies</a>.</p>
  </section>
  </div>
  <div class="set-page" data-page="general"${pageAttr('general')}>
    ${head('general')}
  <section id="set-you">
    <h3>You</h3>
    <div class="grid2">
      <label class="field"><span>Name for the greeting</span><input id="s-name" type="text" data-path="name" value="${esc(d.name)}" autocomplete="off"></label>
      <label class="field"><span>Theme</span><select id="s-theme" data-path="theme">${opt('system', 'Match my computer', d.theme)}${opt('light', 'Light', d.theme)}${opt('dark', 'Dark', d.theme)}</select></label>
      <label class="field"><span>Clock</span><select id="s-clock" data-path="clock24" data-type="bool">${opt(false, '12-hour (3:30 PM)', d.clock24)}${opt(true, '24-hour (15:30)', d.clock24)}</select></label>
      <label class="field"><span>Temperature</span><select id="s-units" data-path="units">${opt('F', 'Fahrenheit (°F)', d.units)}${opt('C', 'Celsius (°C)', d.units)}</select></label>
    </div>
  </section>
  <section id="set-backup">
    <h3>Back up and restore</h3>
    <p class="hint">Save your settings, layout, notes, site groups and companies to a file, or bring them back from one, on this computer or another. The file holds any keys you’ve pasted in Settings; API keys for Claude, ChatGPT and Gemini stay out of it.</p>
    <div class="row wrap">
      <button class="btn small" type="button" data-action="backup">${icon('copy')}Save a backup</button>
      <label class="btn small file-btn">${icon('refresh')}Restore from a backup<input type="file" id="s-restore" accept="application/json,.json"></label>
    </div>
    <p class="hint" id="backup-msg" aria-live="polite"></p>
  </section>
  </div>
  <div class="set-page" data-page="accounts"${pageAttr('accounts')}>
    ${head('accounts')}
  <section id="set-accounts">
    <div class="acct">
      <h4>Google Calendar</h4>
      <div id="sheet-google"></div>
    </div>
    <div class="acct">
      <h4>Gmail</h4>
      <div id="sheet-gmail"></div>
    </div>
    <div class="acct">
      <h4>Outlook</h4>
      <div id="sheet-outlook"></div>
      <div class="row wrap"><span class="swatch-label">Outlook calendar color ${colorSelect('id="s-ms-color" data-path="outlook.color" data-type="number"', d.outlook.color)}</span></div>
    </div>
    <button class="btn small" type="button" data-action="rerun">${icon('refresh')}Run first-time setup again</button>
  </section>
  <section id="set-advanced">
    <details>
      <summary>Advanced</summary>
      <label class="field"><span>Microsoft app (client) ID</span><input id="s-ms-client" type="text" data-path="outlook.clientId" value="${esc(d.outlook.clientId)}" placeholder="Leave empty to use the one built into this copy" spellcheck="false" autocomplete="off"></label>
      <p class="hint">Only needed if you registered your own Microsoft app. Redirect URI: <code>${esc(chrome.identity?.getRedirectURL?.() || '')}</code></p>
    </details>
  </section>
  </div>
  <div class="set-page" data-page="search"${pageAttr('search')}>
    ${head('search')}
  <section id="set-search">
    <h3>Search</h3>
    <div class="grid2">
      <label class="field"><span>Default search</span><select id="s-engine" data-path="searchEngine">${Object.entries(ENGINES).map(([k, e]) => opt(k, e.label, d.searchEngine)).join('')}</select></label>
    </div>
    <p class="hint">Press <code>/</code> anywhere on the page to jump to the search box. The circle at its start switches between Claude, ChatGPT, Gemini and your default search; the one you leave it on becomes the default.</p>
    ${more(`<p class="hint">Start a search with one of these to use another engine just once:</p><ul class="bangs">${Object.values(ENGINES).map((e) => `<li><code>!${esc(e.bang)}</code> ${esc(e.label)}</li>`).join('')}</ul>`, 'Shortcuts for other engines')}
  </section>
  <section id="set-ai">
    <h3>Answers from Claude, ChatGPT and Gemini</h3>
    <p class="hint">Switch the search box to Claude, ChatGPT or Gemini (or start with <code>!c</code>, <code>!gpt</code> or <code>!gem</code>) and ask a question; the answer drops down under the search box.</p>
    <h4>With your own plan, no key</h4>
    <p class="hint">The AI’s own site answers in the drop-down, signed in with your account in Chrome, so it uses your plan (Claude Pro, ChatGPT Plus, Google AI). Sign in to each once:</p>
    ${aiSignIns()}
    <h4>With an API key</h4>
    <p class="hint">The answer is written right on the page, with follow-ups there too. API use is billed separately by Anthropic, OpenAI or Google. Keys stay on this computer and don’t sync.</p>
    <div class="grid2">
      <label class="field"><span>Anthropic API key</span><input id="s-anthropic" type="password" data-ai="anthropicKey" value="${esc(aiDraft.anthropicKey)}" placeholder="sk-ant-…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Claude model</span><select id="s-claude-model" data-ai="claudeModel">${Object.entries(CLAUDE_MODELS).map(([k, label]) => opt(k, label, aiDraft.claudeModel)).join('')}</select></label>
      <label class="field"><span>OpenAI API key</span><input id="s-openai" type="password" data-ai="openaiKey" value="${esc(aiDraft.openaiKey)}" placeholder="sk-…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>ChatGPT model</span><input id="s-openai-model" type="text" data-ai="openaiModel" value="${esc(aiDraft.openaiModel)}" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Gemini API key</span><input id="s-gemini" type="password" data-ai="geminiKey" value="${esc(aiDraft.geminiKey)}" placeholder="AIza…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Gemini model</span><input id="s-gemini-model" type="text" data-ai="geminiModel" value="${esc(aiDraft.geminiModel)}" spellcheck="false" autocomplete="off"></label>
    </div>
    <p class="hint">Get keys at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>, <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a> and <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>.</p>
  </section>
  </div>
  <p class="quiet set-none" id="set-none" hidden>No settings match. Try another word.</p>
  </div>
  </div>

  <footer class="sheet-foot">
    <span class="hint" id="save-state">Changes save as you go.</span>
    <span class="hint sheet-version" id="sheet-version"></span>
    <button class="btn primary" type="submit" value="done">Done</button>
  </footer>
</form>`;
}

const listAt = (path) => path.split('.').reduce((o, k) => o[k], draft);

function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], draft)[last] = value;
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') return Number(el.value);
  if (el.dataset.type === 'bool') return el.value === 'true';
  return el.value;
}

// The list down the side, the counts and the warnings follow every change.
function paintStatus() {
  const nav = $('#settings .sheet-nav');
  if (nav) {
    const current = nav.querySelector('[aria-current]')?.dataset.goto;
    nav.innerHTML = navHtml();
    for (const b of $$('[data-goto]', nav)) if (b.dataset.goto === current && !query) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    if (query) markNav();
  }
  for (const t of $$('#settings .ov-tile')) {
    const s = statusOf(t.dataset.disp);
    t.querySelector('.ov-status').textContent = s.text;
    t.classList.toggle('warn', Boolean(s.warn) && !isOff(t.dataset.disp));
  }
  const n = $('#ov-needs');
  if (n) n.innerHTML = attention();
  const tn = $('#ov-ticker-n');
  if (tn) tn.textContent = Object.keys(TICKER_CARDS).filter((k) => onTicker(draft, k)).length + (draft.tickerOptions?.extras || []).filter((x) => x.on !== false).length;
  const fn = $('#ov-flip-n');
  if (fn) fn.textContent = Object.keys(TICKER_CARDS).filter((k) => tickerMode(draft, k) === 'flip').length;
}

function queueSave() {
  dirty = true;
  clearTimeout(saveTimer);
  const s = $('#save-state');
  if (s) {
    s.textContent = 'Saving…';
    s.classList.remove('save-error');
  }
  saveTimer = setTimeout(async () => {
    const el = $('#save-state');
    try {
      await saveSettings(draft);
      if (el) el.textContent = 'Saved. The page updates when you close Settings.';
    } catch (err) {
      // Chrome keeps at most 8 KB of settings in sync: too many extras or rules can pass it.
      if (el) el.textContent = /quota/i.test(err?.message) ? 'Too much to save: Chrome syncs at most 8 KB of settings. Remove an extra or a rule.' : `Couldn’t save: ${err?.message || err}`;
      el?.classList.add('save-error');
    }
  }, 250);
  paintStatus();
}

async function mountHolidays() {
  const box = $('#sheet-holidays');
  let list;
  try {
    list = await holidayChoices();
  } catch {
    list = [];
  }
  if (!box.isConnected) return;
  const date = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  box.innerHTML = list.length
    ? list
        .map(
          (h) => `<label class="check hol-choice" style="--hol: ${h.theme.color}"><input type="checkbox" data-holiday="${esc(h.key)}"${draft.holidays.choices[h.key] ?? h.on ? ' checked' : ''}>
        <span class="hol-glyph" aria-hidden="true">${h.theme.glyph}</span><span class="hol-choice-text"><span>${esc(h.name)}</span><span class="hol-date">${h.key === 'clocks' ? 'Spring and fall' : esc(date(h.at))}</span></span></label>`,
        )
        .join('')
    : '<p class="quiet">The holiday list couldn’t be loaded right now.</p>';
}

// The watchlist: a chip for each symbol, a box to add one, and popular ones to add with a click.
function mountSymbols(el) {
  const paint = (msg = '') => {
    const list = stockSymbols(draft);
    const full = list.length >= MAX_SYMBOLS;
    el.innerHTML = `<div class="sym-chips">${list
      .map((s, i) => `<span class="sym-chip"><span>${esc(s)}</span>${i ? `<button type="button" data-sym-left="${i}" aria-label="Move ${esc(s)} earlier" title="Move earlier">${icon('chevron-left')}</button>` : ''}<button type="button" data-sym-remove="${esc(s)}" aria-label="Remove ${esc(s)}" title="Remove">${icon('close')}</button></span>`)
      .join('') || '<span class="hint">No symbols yet.</span>'}</div>
      ${full
        ? `<p class="hint">That’s the most the card holds (${MAX_SYMBOLS}). Remove one to add another.</p>`
        : `<div class="row sym-add">
          <label class="field"><span>Add a symbol</span><input type="text" id="s-sym-add" placeholder="AAPL" spellcheck="false" autocomplete="off" maxlength="20"></label>
          <button class="btn small" type="button" data-sym-add-typed>${icon('plus')}Add</button>
        </div>
        <p class="hint sym-msg" aria-live="polite">${esc(msg)}</p>
        <div class="sym-popular"><span class="hint">Popular:</span>${POPULAR.filter((s) => !list.includes(s))
          .map((s) => `<button class="chip" type="button" data-sym-add="${s}">${icon('plus')}${s}</button>`)
          .join('')}</div>`}`;
  };
  const add = (raw) => {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return paint();
    if (!/^[A-Z0-9.:^=-]{1,20}$/.test(s)) return paint(`“${raw}” doesn’t look like a symbol.`);
    if (stockSymbols(draft).includes(s)) return paint(`${s} is already on the list.`);
    draft.stocks.symbols = [...stockSymbols(draft), s];
    queueSave();
    paint();
    el.querySelector('#s-sym-add')?.focus();
  };
  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-sym-add]');
    const remove = e.target.closest('[data-sym-remove]');
    const left = e.target.closest('[data-sym-left]');
    if (pick) add(pick.dataset.symAdd);
    else if (e.target.closest('[data-sym-add-typed]')) add(el.querySelector('#s-sym-add').value);
    else if (remove) {
      draft.stocks.symbols = stockSymbols(draft).filter((s) => s !== remove.dataset.symRemove);
      queueSave();
      paint();
    } else if (left) {
      const list = stockSymbols(draft);
      const i = Number(left.dataset.symLeft);
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      draft.stocks.symbols = list;
      queueSave();
      paint();
    }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 's-sym-add') {
      e.preventDefault();
      add(e.target.value);
    }
  });
  paint();
}

// The version in the folder, which is what this page runs, even before Finish update.
async function paintVersion() {
  let v = chrome.runtime?.getManifest?.().version || '';
  try {
    v = (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then((r) => r.json())).version || v;
  } catch {}
  const el = $('#sheet-version');
  if (el && v) el.textContent = `Daybook ${v}`;
}

function mountAll() {
  paintVersion();
  mountHolidays();
  mountGoogle($('#sheet-google'), draft, queueSave);
  mountGmail($('#sheet-gmail'), draft, queueSave);
  mountOutlook($('#sheet-outlook'), draft, queueSave);
  mountLocation($('#sheet-location'), draft, queueSave);
  mountTeams($('#sheet-teams'), draft, queueSave);
  tickerPage = mountTicker($('#sheet-ticker'), draft, queueSave);
  mountJobs($('#sheet-jobs'), draft, queueSave);
  mountTracking($('#sheet-tracking'), draft, queueSave);
  mountShippingFolders($('#sheet-ship-folders'), draft, queueSave);
  mountSymbols($('#sheet-symbols'));
  paintGroups();
}

// Site groups save on their own (see sites.js), so the page shows a change without reloading.
async function paintGroups() {
  const el = $('#sheet-groups');
  if (!el) return;
  const groups = await groupList();
  el.innerHTML = groups.length
    ? groups
        .map(
          (g) => `<div class="group-row">
          <span class="group-icon small">${icon(hasIcon(g.icon) ? g.icon : 'folder')}</span>
          <span class="group-row-name">${esc(g.name)}</span>
          <span class="hint">${g.sites.length} ${g.sites.length === 1 ? 'site' : 'sites'}</span>
          <button class="btn small" type="button" data-action="edit-group" data-id="${esc(g.id)}">${icon('edit')}Edit</button>
        </div>`,
        )
        .join('')
    : '<p class="hint">No groups yet.</p>';
}

function rerender() {
  const dlg = $('#settings');
  const scroll = dlg.scrollTop;
  dlg.innerHTML = build();
  mountAll();
  if (query) find(query);
  dlg.scrollTop = scroll;
}

// ---- Back up and restore -----------------------------------------------------------------

async function backup() {
  clearTimeout(saveTimer);
  await saveSettings(draft);
  const all = await chrome.storage.sync.get(null);
  const file = { daybook: chrome.runtime.getManifest().version, saved: new Date().toISOString(), sync: all };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  a.download = `daybook-settings-${new Date().toLocaleDateString('en-CA')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('#backup-msg').textContent = 'Saved to your downloads.';
}

async function restore(input) {
  const msg = $('#backup-msg');
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  let file;
  try {
    file = JSON.parse(await f.text());
  } catch {
    msg.textContent = 'That file isn’t a Daybook backup.';
    return;
  }
  if (!file?.sync?.settings || typeof file.sync !== 'object') {
    msg.textContent = 'That file isn’t a Daybook backup.';
    return;
  }
  if (!confirm(`Replace your settings with the ones saved ${file.saved ? new Date(file.saved).toLocaleDateString() : 'in this file'}? Your layout, notes and site groups come back as they were then too.`)) return;
  clearTimeout(saveTimer);
  try {
    await chrome.storage.sync.set(file.sync);
  } catch (err) {
    msg.textContent = `Couldn’t restore it: ${err.message || err}.`;
    return;
  }
  dirty = false;
  location.reload();
}

// ---- Pages and searching ----------------------------------------------------------------

function showPage(id) {
  page = PAGES[id] ? id : 'display';
  query = '';
  clearMarks();
  if (page === 'ticker') tickerPage?.paint();
  const q = $('#set-q');
  if (q) q.value = '';
  $('#set-count').textContent = '';
  for (const el of $$('#settings .set-page')) el.hidden = el.dataset.page !== page;
  for (const el of $$('#settings .set-page section, #settings .set-page .set-note')) el.hidden = false;
  for (const b of $$('#settings .sheet-nav [data-goto]')) {
    b.classList.remove('has-match');
    if (b.dataset.goto !== page) b.removeAttribute('aria-current');
    else {
      b.setAttribute('aria-current', 'page');
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  $('#set-none').hidden = true;
  $('#settings').scrollTop = 0;
}

function clearMarks() {
  CSS.highlights?.delete('set-find');
}

// Marks every place the words show on the pages showing (CSS Custom Highlights, so the page
// itself doesn't change), and opens folded-away text that has them.
function mark(q) {
  if (!globalThis.Highlight || !CSS.highlights) return 0;
  const ranges = [];
  for (const sec of $$('#settings .set-page:not([hidden]) :is(section, .page-head, .set-note):not([hidden])')) {
    const walk = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('option, select, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n; (n = walk.nextNode()); ) {
      const text = n.textContent.toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = new Range();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        ranges.push(r);
        n.parentElement.closest('details')?.setAttribute('open', '');
      }
    }
  }
  CSS.highlights.set('set-find', new Highlight(...ranges));
  return ranges.length;
}

// Pages with something that matches get a dot in the list down the side.
function markNav() {
  for (const b of $$('#settings .sheet-nav [data-goto]')) {
    const p = $(`#settings .set-page[data-page="${b.dataset.goto}"]`);
    b.classList.toggle('has-match', Boolean(p && !p.hidden));
  }
}

// Searching shows every page at once, with only the parts that mention what was typed (or all
// of a page whose name or description matches), the words marked where they are.
function find(text) {
  query = text.trim();
  clearMarks();
  if (!query) return showPage(page);
  const q = query.toLowerCase();
  let pages = 0;
  tickerPage?.paint();
  for (const p of $$('#settings .set-page')) {
    const info = PAGES[p.dataset.page];
    const whole = `${info.label} ${info.about}`.toLowerCase().includes(q);
    let shown = 0;
    for (const sec of $$('section, .set-note', p)) {
      sec.hidden = !whole && !sec.textContent.toLowerCase().includes(q);
      if (!sec.hidden) shown++;
    }
    p.hidden = !shown && !whole;
    if (!p.hidden) pages++;
  }
  for (const b of $$('#settings .sheet-nav [aria-current]')) b.removeAttribute('aria-current');
  markNav();
  const n = mark(q);
  $('#set-none').hidden = pages > 0;
  $('#set-count').textContent = pages ? `${n || 'All'} on ${pages} ${pages === 1 ? 'page' : 'pages'}` : '';
  $('#settings').scrollTop = 0;
}

// The same choice is drawn on Cards and ticker and on the card's own page.
function setDisplay(key, mode) {
  draft.ticker[key] = mode;
  const sec = TICKER_CARDS[key].section;
  draft.show[sec] = Object.keys(TICKER_CARDS).some((k) => TICKER_CARDS[k].section === sec && tickerMode(draft, k) !== 'off');
  for (const r of $$(`#settings input[data-display="${key}"]`)) r.checked = r.value === mode;
  for (const s of $$(`#settings select[data-display="${key}"]`)) s.value = mode;
  for (const row of $$(`#settings [data-disp="${key}"]`)) row.classList.toggle('is-off', mode === 'off');
  for (const cb of $$(`#settings [data-flip-pick="${key}"]`)) cb.checked = mode === 'flip';
}

let wired = false;

function wire(dlg) {
  if (wired) return;
  wired = true;
  const onEdit = (e) => {
    const el = e.target;
    if (el.closest('#sheet-google, #sheet-gmail, #sheet-outlook, #sheet-location, #sheet-teams, #sheet-ticker, #sheet-jobs, #sheet-tracking, #sheet-ship-folders, #sheet-symbols')) return;
    if (el.id === 'set-q') return find(el.value);
    if (el.id === 's-restore') return e.type === 'change' && restore(el);
    if (el.dataset.flipPick) {
      // Unticked, a card goes back to its own spot on the board.
      if (el.checked !== (tickerMode(draft, el.dataset.flipPick) === 'flip')) setDisplay(el.dataset.flipPick, el.checked ? 'flip' : 'card');
      queueSave();
      return;
    }
    if (el.dataset.display) {
      if (el.tagName === 'SELECT' || el.checked) setDisplay(el.dataset.display, el.value);
      queueSave();
      return;
    }
    if (el.dataset.ai) {
      // Saved straight to this computer; the search box picks it up without a reload.
      aiDraft[el.dataset.ai] = el.value.trim();
      saveAi(aiDraft);
      return;
    }
    if (el.dataset.path) {
      setPath(el.dataset.path, readValue(el));
    } else if (el.dataset.list) {
      listAt(el.dataset.list)[Number(el.dataset.i)][el.dataset.field] = readValue(el);
    } else if (el.dataset.holiday) {
      draft.holidays.choices = { ...draft.holidays.choices, [el.dataset.holiday]: el.checked };
    } else if (el.dataset.topic) {
      const set = new Set(draft.news.topics);
      if (el.checked) set.add(el.dataset.topic);
      else set.delete(el.dataset.topic);
      draft.news.topics = Object.keys(NEWS_TOPICS).filter((k) => set.has(k));
    } else if (el.dataset.areaKind) {
      const set = new Set(draft.area.kinds);
      if (el.checked) set.add(el.dataset.areaKind);
      else set.delete(el.dataset.areaKind);
      draft.area.kinds = Object.keys(AREA_KINDS).filter((k) => set.has(k));
    } else if (el.dataset.index) {
      const set = new Set(draft.stocks.indexes || []);
      if (el.checked) set.add(el.dataset.index);
      else set.delete(el.dataset.index);
      draft.stocks.indexes = Object.keys(INDEXES).filter((k) => set.has(k));
    } else return;
    if (el.classList.contains('swatch')) el.previousElementSibling.style.setProperty('--c', `var(--cat-${el.value})`);
    queueSave();
  };
  dlg.addEventListener('input', onEdit);
  dlg.addEventListener('change', onEdit);
  dlg.addEventListener('keydown', (e) => {
    // Enter in the search box would submit the form, which closes the sheet.
    if (e.key === 'Enter' && e.target.id === 'set-q') e.preventDefault();
    // / or Ctrl+F (⌘F) jumps to the search box; up and down move through the list down the side.
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
      e.preventDefault();
      $('#set-q')?.select();
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.sheet-nav')) {
      e.preventDefault();
      const all = $$('#settings .sheet-nav [data-goto]');
      const next = all[all.indexOf(e.target.closest('[data-goto]')) + (e.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
      if (next) showPage(next.dataset.goto);
    }
  });
  // Escape clears a search before it closes the sheet.
  dlg.addEventListener('cancel', (e) => {
    if (!query) return;
    e.preventDefault();
    showPage(page);
    $('#set-q')?.focus();
  });

  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) {
      dlg.requestClose ? dlg.requestClose() : dlg.close();
      return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) {
      showPage(go.dataset.goto);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'remove') {
      listAt(btn.dataset.list).splice(Number(btn.dataset.i), 1);
      queueSave();
      rerender();
    } else if (action === 'add-calendar') {
      const used = new Set(draft.calendars.map((c) => c.color));
      draft.calendars.push({ id: `c${Date.now().toString(36)}`, name: 'New calendar', color: COLORS.find((c) => !used.has(c)) ?? 1, url: '', enabled: true });
      queueSave();
      rerender();
      $(`#s-cal-${draft.calendars.length - 1}-url`)?.focus();
    } else if (action === 'add-feed') {
      draft.news.custom.push({ label: '', url: '' });
      queueSave();
      rerender();
      $(`#s-feed-${draft.news.custom.length - 1}-url`)?.focus();
    } else if (action === 'add-group' || action === 'edit-group') {
      openGroupEditor(action === 'edit-group' ? btn.dataset.id : null, paintGroups);
    } else if (action === 'backup') {
      backup();
    } else if (action === 'rerun') {
      draft.onboarded = false;
      queueSave();
      dlg.close();
    }
  });

  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Calendar and feed links on other hosts need Chrome's OK; this click counts as the gesture.
    const origins = [...new Set(extraOrigins([
      ...draft.calendars.map((c) => c.url),
      ...draft.news.custom.map((f) => f.url),
      ...(draft.tickerOptions?.extras || []).filter((x) => x.kind === 'feed').map((x) => x.url),
    ].filter(Boolean)))];
    if (origins.length) {
      try {
        const has = await chrome.permissions.contains({ origins });
        if (!has) await chrome.permissions.request({ origins });
      } catch {}
    }
    dlg.close();
  });

  dlg.addEventListener('close', async () => {
    clearTimeout(saveTimer);
    clearMarks();
    if (!dirty) return;
    try {
      await saveSettings(draft);
    } catch {}
    location.reload();
  });
}

export async function openSettings(S, section) {
  const dlg = $('#settings');
  aiDraft = await loadAi();
  draft = structuredClone(S);
  dirty = false;
  query = '';
  wire(dlg);
  dlg.innerHTML = build();
  mountAll();
  dlg.showModal();
  // Other parts of Daybook open Settings at a whole page (`weather`) or a part of one (`location`).
  const target = section && !PAGES[section] && $(`#set-${section}`);
  showPage(PAGES[section] ? section : target ? target.closest('.set-page').dataset.page : page);
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.add('flash');
    $$('input, select, button', target)[0]?.focus({ preventScroll: true });
  }
}
