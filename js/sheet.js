// The Settings sheet: a page for each part of Daybook, picked from the list down the side, and a
// search box that looks through all of them. Every card and part of the top bar can be shown on
// the page, in the ticker, both or not at all, all of them together under Cards and ticker and
// each on its own page too. Every change saves as you make it; closing the sheet reloads the page
// so each card picks up the new settings.
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
import { mountJobs } from './jobs.js';
import { TICKER_CARDS, tickerMode, tickerModes } from './ticker.js';
import { mountTracking } from './tracking.js';

let draft;
let aiDraft;
let dirty = false;
let saveTimer;
let page = 'display'; // the page shown, kept between openings
let query = '';

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];
const COLOR_NAMES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Magenta', 'Green', 'Violet', 'Red'];

const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
const check = (path, label, on) =>
  `<label class="check"><input type="checkbox" data-path="${path}"${on ? ' checked' : ''}><span>${label}</span></label>`;

function colorSelect(attrs, current) {
  return `<span class="swatch-wrap"><span class="cal-dot" style="--c: var(--cat-${current})"></span><select class="swatch" ${attrs} aria-label="Color">${COLORS.map((c) => opt(c, COLOR_NAMES[c - 1], current)).join('')}</select></span>`;
}

const PAGES = {
  display: { label: 'Cards and ticker', icon: 'eye' },
  flip: { label: 'Flip card', icon: 'refresh' },
  general: { label: 'General', icon: 'gear' },
  accounts: { label: 'Accounts', icon: 'person' },
  search: { label: 'Search and AI', icon: 'search' },
  weather: { label: 'Weather', icon: 'drop', show: ['weather', 'alerts'] },
  calendar: { label: 'Calendar', icon: 'clock', show: ['today', 'month', 'holidays'] },
  mail: { label: 'Mail and deliveries', icon: 'mail', show: ['mail', 'deliveries'] },
  news: { label: 'Headlines', icon: 'globe', show: ['news'] },
  youtube: { label: 'YouTube', icon: 'video', show: ['youtube'] },
  stocks: { label: 'Markets', icon: 'money', show: ['stocks'] },
  teams: { label: 'Teams', icon: 'star', show: ['teams'] },
  area: { label: 'Around you', icon: 'pin', show: ['area'] },
  jobs: { label: 'NYS jobs', icon: 'building', show: ['jobs'] },
  shortcuts: { label: 'Shortcuts and notes', icon: 'link', show: ['shortcuts', 'notes'] },
};
const pageOf = (key) => Object.keys(PAGES).find((id) => PAGES[id].show?.includes(key));
const pageAttr = (id) => (id === page || query ? '' : ' hidden');

// Where one card or part of the top bar shows: on the page, in the ticker, both or neither.
// It's drawn twice (under Cards and ticker and on its own page), as two sets of radios kept in step.
function display(key, where) {
  const c = TICKER_CARDS[key];
  const mode = tickerMode(draft, key);
  const names = { card: c.board, both: `${c.board} + ticker`, ticker: 'Ticker only', flip: 'Flip card', off: 'Off' };
  return `<div class="disp${mode === 'off' ? ' is-off' : ''}" data-disp="${key}">
    <span class="disp-name">${icon(c.icon)}<span>${esc(c.label)}</span>${
      where === 'all' ? `<button class="disp-go" type="button" data-goto="${pageOf(key)}" title="${esc(c.label)} settings">Options${icon('chevron-right')}</button>` : ''
    }</span>
    <span class="seg disp-seg" role="radiogroup" aria-label="Where ${esc(c.label)} shows">${tickerModes(key)
      .map((m) => `<label><input type="radio" name="disp-${key}-${where}" value="${m}" data-display="${key}"${m === mode ? ' checked' : ''}><span>${esc(names[m])}</span></label>`)
      .join('')}</span>
  </div>`;
}

const showBlock = (id) => `<section id="set-show-${id}" class="set-show">
    <h3>Where it shows</h3>
    ${PAGES[id].show.map((k) => display(k, 'page')).join('')}
  </section>`;

function overview() {
  const keys = Object.keys(TICKER_CARDS);
  const group = (board) => keys.filter((k) => TICKER_CARDS[k].board === board).map((k) => display(k, 'all')).join('');
  return `<section id="set-ticker">
    <p class="hint">Pick where each part of Daybook shows: on the page, in the ticker, both, in the flip card (see <button class="linklike" type="button" data-goto="flip">Flip card</button>), or not at all. The ticker is a bar under the top band that crawls through the latest from everything you put in it, taking turns. Hover over it to hold it still, scroll it to look along it, and click anything to open it. <strong>Options</strong> opens that part’s own settings.</p>
  </section>
  <section id="set-sections">
    <h3>Top bar</h3>
    ${group('Top bar')}
  </section>
  <section id="set-cards">
    <h3>Cards</h3>
    ${group('Card')}
  </section>`;
}

// The flip card's own page: which cards take turns in it, and how often it turns.
function flipPage() {
  const keys = Object.keys(TICKER_CARDS).filter((k) => tickerModes(k).includes('flip'));
  return `<section id="set-flip">
    <p class="hint">Tick the cards to put in the flip card. They leave their own spots and share one card on the board, taking turns: it turns over to the next every so often, and the tabs along its top pick one by hand. It holds still while the pointer or the keyboard is on it. Move it like any card with <strong>Arrange cards</strong>. With nothing ticked, there’s no flip card.</p>
    <div class="topics">${keys
      .map((k) => `<label class="check"><input type="checkbox" data-flip-pick="${k}"${tickerMode(draft, k) === 'flip' ? ' checked' : ''}><span>${esc(TICKER_CARDS[k].label)}</span></label>`)
      .join('')}</div>
    <label class="field inline"><span>Turn to the next</span><select id="s-flip-every" data-path="flip.every" data-type="number">${[[10, 'Every 10 seconds'], [20, 'Every 20 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute'], [0, 'Only when I pick one']].map(([n, l]) => opt(n, l, draft.flip.every)).join('')}</select></label>
  </section>`;
}

function build() {
  const d = draft;
  return `<form method="dialog" class="sheet-inner" id="settings-form" novalidate>
  <header class="sheet-head">
    <h2>Settings</h2>
    <label class="sheet-find">${icon('search')}<input id="set-q" type="search" placeholder="Search settings" value="${esc(query)}" autocomplete="off" spellcheck="false" aria-label="Search settings"></label>
    <button class="icon-btn" type="submit" value="done" aria-label="Close settings">${icon('close')}</button>
  </header>

  <div class="sheet-body">
  <nav class="sheet-nav" aria-label="Settings pages">${Object.entries(PAGES)
    .map(([id, p]) => `<button type="button" data-goto="${id}"${id === page && !query ? ' aria-current="page"' : ''}>${icon(p.icon)}<span>${esc(p.label)}</span></button>`)
    .join('')}</nav>
  <div class="sheet-pages">
  <div class="set-page" data-page="display"${pageAttr('display')}>
    <h2 class="page-title">${PAGES.display.label}</h2>
${overview()}
  </div>
  <div class="set-page" data-page="flip"${pageAttr('flip')}>
    <h2 class="page-title">${PAGES.flip.label}</h2>
${flipPage()}
  </div>
  <div class="set-page" data-page="general"${pageAttr('general')}>
    <h2 class="page-title">${PAGES.general.label}</h2>
  <section id="set-you">
    <h3>You</h3>
    <div class="grid2">
      <label class="field"><span>Name for the greeting</span><input id="s-name" type="text" data-path="name" value="${esc(d.name)}" autocomplete="off"></label>
      <label class="field"><span>Theme</span><select id="s-theme" data-path="theme">${opt('system', 'Match my computer', d.theme)}${opt('light', 'Light', d.theme)}${opt('dark', 'Dark', d.theme)}</select></label>
      <label class="field"><span>Clock</span><select id="s-clock" data-path="clock24" data-type="bool">${opt(false, '12-hour (3:30 PM)', d.clock24)}${opt(true, '24-hour (15:30)', d.clock24)}</select></label>
      <label class="field"><span>Temperature</span><select id="s-units" data-path="units">${opt('F', 'Fahrenheit (°F)', d.units)}${opt('C', 'Celsius (°C)', d.units)}</select></label>
    </div>
  </section>
  </div>
  <div class="set-page" data-page="accounts"${pageAttr('accounts')}>
    <h2 class="page-title">${PAGES.accounts.label}</h2>
  <section id="set-accounts">
    <h3>Accounts</h3>
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
    <h2 class="page-title">${PAGES.search.label}</h2>
  <section id="set-search">
    <h3>Search</h3>
    <div class="grid2">
      <label class="field"><span>Default search</span><select id="s-engine" data-path="searchEngine">${Object.entries(ENGINES).map(([k, e]) => opt(k, e.label, d.searchEngine)).join('')}</select></label>
    </div>
    <p class="hint">Start a search with <code>!g</code>, <code>!y</code>, <code>!m</code>, <code>!w</code>, <code>!a</code>, <code>!e</code>, <code>!c</code>, <code>!gpt</code> or <code>!gem</code> to use another engine just once, and press <code>/</code> anywhere on the page to jump to the search box. The circle at the start of the search box switches it between Claude, ChatGPT, Gemini and your default search; the one you leave it on becomes the default.</p>
  </section>
  <section id="set-ai">
    <h3>Answers from Claude, ChatGPT and Gemini</h3>
    <p class="hint">Click the circle at the start of the search box until it shows Claude, ChatGPT or Gemini (or start with <code>!c</code>, <code>!gpt</code> or <code>!gem</code>) to ask a question. The answer drops down under the search box. Without an API key, that’s the AI’s own site, signed in with your account in Chrome, so it uses your own plan (Claude Pro, ChatGPT Plus, Google AI) and nothing else is needed; your next question opens that chat on the site, typed in and ready to send. Sign in to each once:</p>
    ${aiSignIns()}
    <p class="hint">Or add an API key and the answer is written right on the page, with follow-ups there too. API use is billed separately by Anthropic, OpenAI or Google. Keys stay on this computer and don’t sync.</p>
    <div class="grid2">
      <label class="field"><span>Anthropic API key</span><input id="s-anthropic" type="password" data-ai="anthropicKey" value="${esc(aiDraft.anthropicKey)}" placeholder="sk-ant-…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Claude model</span><select id="s-claude-model" data-ai="claudeModel">${Object.entries(CLAUDE_MODELS).map(([k, label]) => opt(k, label, aiDraft.claudeModel)).join('')}</select></label>
      <label class="field"><span>OpenAI API key</span><input id="s-openai" type="password" data-ai="openaiKey" value="${esc(aiDraft.openaiKey)}" placeholder="sk-…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>ChatGPT model</span><input id="s-openai-model" type="text" data-ai="openaiModel" value="${esc(aiDraft.openaiModel)}" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Gemini API key</span><input id="s-gemini" type="password" data-ai="geminiKey" value="${esc(aiDraft.geminiKey)}" placeholder="AIza…" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Gemini model</span><input id="s-gemini-model" type="text" data-ai="geminiModel" value="${esc(aiDraft.geminiModel)}" spellcheck="false" autocomplete="off"></label>
    </div>
    <p class="hint">Get an Anthropic key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> and an OpenAI key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a> and a Gemini key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>.</p>
  </section>
  </div>
  <div class="set-page" data-page="weather"${pageAttr('weather')}>
    <h2 class="page-title">${PAGES.weather.label}</h2>
${showBlock('weather')}
  <section id="set-location">
    <h3>Weather location</h3>
    <div id="sheet-location"></div>
  </section>
  </div>
  <div class="set-page" data-page="calendar"${pageAttr('calendar')}>
    <h2 class="page-title">${PAGES.calendar.label}</h2>
${showBlock('calendar')}
  <section id="set-calendars">
    <h3>Other calendars</h3>
    <p class="hint">Add any calendar that has an iCal (.ics) link: an Outlook calendar published from Outlook.com (Settings → Calendar → Shared calendars → <em>Publish a calendar</em>), an iCloud calendar shared publicly, a sports schedule or a school calendar. Treat private links like passwords.</p>
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
  </section>
  <section id="set-holidays">
    <h3>Holidays</h3>
    <p class="hint">Pick the holidays to show under the date and on the month calendar. Each one has its own colors and emblem.</p>
    <div class="topics hol-choices" id="sheet-holidays"><p class="quiet">Loading holidays…</p></div>
  </section>
  <section id="set-travel">
    <h3>Travel time</h3>
    <p class="hint">For events with an address, Daybook shows the weather there and, for the next 24 hours, when to leave from where you are. Addresses are looked up with Photon (OpenStreetMap), and drive times come from OSRM, which doesn’t know about traffic.</p>
    <div class="trk-mail">${check('show.travel', 'Show travel time and event weather', d.show.travel)}</div>
    <div class="grid2">
      <label class="field"><span>Extra time before leaving</span><select id="s-buffer" data-path="travel.buffer" data-type="number">${[0, 5, 10, 15, 20, 30].map((m) => opt(m, m ? `${m} minutes` : 'None', d.travel.buffer)).join('')}</select></label>
      <label class="field"><span>TomTom key for live traffic (optional)</span><input id="s-tomtom" type="text" data-path="travel.tomtomKey" value="${esc(d.travel.tomtomKey)}" placeholder="Paste your TomTom API key" spellcheck="false" autocomplete="off"></label>
    </div>
    <p class="hint">To get a TomTom key, sign up free at <a href="https://developer.tomtom.com/" target="_blank" rel="noopener">developer.tomtom.com</a> and copy the key from your dashboard.</p>
  </section>
  </div>
  <div class="set-page" data-page="mail"${pageAttr('mail')}>
    <h2 class="page-title">${PAGES.mail.label}</h2>
${showBlock('mail')}
  <section id="set-packages">
    <h3>Package tracking</h3>
    <p class="hint">Daybook reads your shipping emails from the last two weeks in full, read or not, for the tracking number, the delivery day and what’s in the box: Gmail through Gmail’s own page with the sign-in already in Chrome (no setup, nothing changed in your mailbox), Outlook through its sign-in under Accounts. It also follows each package on the carrier’s own site, free and without a key: it opens the tracking page at UPS, USPS, FedEx, DHL or Amazon out of sight and reads the status and delivery day off it, the way you would, every couple of hours while a new tab is open. When a page can’t be read, the newest email about the package stands in. Carriers change their pages now and then; a package whose page can’t be read still links to it.</p>
    <div class="trk-mail">${check('packages.checkSites', 'Check carriers’ tracking pages for the latest status', d.packages.checkSites)}</div>
    <div class="trk-mail">${check('packages.amazonPages', 'Read what’s in Amazon packages from their order pages', d.packages.amazonPages)}</div>
    <p class="hint">Amazon’s shipping emails name only a category, like “Boating Accessories”. With this on, Daybook opens each order’s page on amazon.com out of sight, signed in the way you are in this browser, and takes the item names from it, once an order. Nothing on your account changes.</p>
    <div class="trk-mail">${check('packages.fromMail', 'Find packages in shipping emails too', d.packages.fromMail)}</div>
    <h4>Where to look for shipping emails</h4>
    <div id="sheet-ship-folders"></div>
    <p class="hint">To hear about every package coming to your address without entering anything, sign up (free) for <a href="https://www.ups.com/us/en/services/tracking/mychoice" target="_blank" rel="noopener">UPS My Choice</a>, <a href="https://www.fedex.com/en-us/delivery-manager.html" target="_blank" rel="noopener">FedEx Delivery Manager</a> and <a href="https://informeddelivery.usps.com/" target="_blank" rel="noopener">USPS Informed Delivery</a>: they email you as each one moves, and Daybook reads those emails.</p>
    <h4>Packages you’re tracking</h4>
    <div id="sheet-tracking"></div>
  </section>
  </div>
  <div class="set-page" data-page="news"${pageAttr('news')}>
    <h2 class="page-title">${PAGES.news.label}</h2>
${showBlock('news')}
  <section id="set-news">
    <h3>Headlines</h3>
    <div class="topics">${Object.entries(NEWS_TOPICS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-topic="${k}"${d.news.topics.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
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
  <div class="set-page" data-page="youtube"${pageAttr('youtube')}>
    <h2 class="page-title">${PAGES.youtube.label}</h2>
${showBlock('youtube')}
  <section id="set-youtube">
    <h3>YouTube</h3>
    <p class="hint">New uploads from the channels you subscribe to, from the last week.</p>
    ${check('youtube.hideShorts', 'Hide Shorts', d.youtube.hideShorts)}
  </section>
  </div>
  <div class="set-page" data-page="stocks"${pageAttr('stocks')}>
    <h2 class="page-title">${PAGES.stocks.label}</h2>
${showBlock('stocks')}
  <section id="set-stocks">
    <h3>Stocks</h3>
    <p class="hint">A watchlist card under the weather. It needs a free key from Finnhub: sign up at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a> and copy the API key from your dashboard.</p>
    <div class="grid2">
      <label class="field"><span>Finnhub API key</span><input id="s-finnhub" type="text" data-path="stocks.key" value="${esc(d.stocks.key)}" placeholder="Paste your Finnhub API key" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Symbols, separated by commas (up to 8)</span><input id="s-symbols" type="text" data-path="stocks.symbols" data-type="list" value="${esc(d.stocks.symbols.join(', '))}" placeholder="SPY, AAPL, MSFT" spellcheck="false" autocomplete="off"></label>
    </div>
  </section>
  </div>
  <div class="set-page" data-page="teams"${pageAttr('teams')}>
    <h2 class="page-title">${PAGES.teams.label}</h2>
${showBlock('teams')}
  <section id="set-teams">
    <h3>Teams</h3>
    <p class="hint">Follow teams to get a card with each one’s next game (and the score while it’s on), their games on your calendar with the team’s logo, and recent team news. For a day after a game, the two logos and the score take a turn in the bubble at the end of the search bar, green for a win and red for a loss (the card leaves it out of the team’s last result). Schedules come from ESPN; news from Google News.</p>
    <div id="sheet-teams"></div>
    <div class="topics">
      ${check('teams.calendar', 'Show games on the calendar', d.teams.calendar)}
      ${check('teams.news', 'Show team news', d.teams.news)}
      ${check('teams.wins', 'Show the last score in the search bar for a day', d.teams.wins)}
    </div>
  </section>
  </div>
  <div class="set-page" data-page="area"${pageAttr('area')}>
    <h2 class="page-title">${PAGES.area.label}</h2>
${showBlock('area')}
  <section id="set-area">
    <h3>Area events</h3>
    <p class="hint">Concerts, shows, festivals and games around your weather location, from Ticketmaster. It needs a free key: sign up at <a href="https://developer-acct.ticketmaster.com/user/register" target="_blank" rel="noopener">developer.ticketmaster.com</a>, open <strong>My Apps</strong> and copy the <strong>Consumer Key</strong>. Brewery nights and other small local events are rarely on Ticketmaster, so the card also has quick searches for those.</p>
    <label class="field"><span>Ticketmaster key</span><input id="s-ticketmaster" type="text" data-path="area.key" value="${esc(d.area.key)}" placeholder="Paste your Ticketmaster Consumer Key" spellcheck="false" autocomplete="off"></label>
    <div class="grid2">
      <label class="field"><span>How far</span><select id="s-area-radius" data-path="area.radius" data-type="number">${[10, 25, 50, 100].map((r) => opt(r, `Within ${r} ${d.units === 'C' ? 'km' : 'miles'}`, d.area.radius)).join('')}</select></label>
      <label class="field"><span>How far ahead</span><select id="s-area-days" data-path="area.days" data-type="number">${[[7, 'The next week'], [14, 'The next two weeks'], [30, 'The next month']].map(([n, l]) => opt(n, l, d.area.days)).join('')}</select></label>
    </div>
    <div class="topics">${Object.entries(AREA_KINDS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-area-kind="${k}"${d.area.kinds.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
  </section>
  </div>
  <div class="set-page" data-page="jobs"${pageAttr('jobs')}>
    <h2 class="page-title">${PAGES.jobs.label}</h2>
${showBlock('jobs')}
  <section id="set-jobs">
    <h3>NYS jobs</h3>
    <p class="hint">New vacancies open to the general public on <a href="https://statejobs.ny.gov/public/search.cfm" target="_blank" rel="noopener">StateJobsNY</a>, New York State’s jobs site. These are the options of the site’s own search; the card shows the postings that match all of the ones you set, and any rules of your own below them. Daybook keeps two weeks of postings, and reads each one’s page for the salary and the rest.</p>
    <div id="sheet-jobs"></div>
  </section>
  </div>
  <div class="set-page" data-page="shortcuts"${pageAttr('shortcuts')}>
    <h2 class="page-title">${PAGES.shortcuts.label}</h2>
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
  <p class="quiet set-none" id="set-none" hidden>No settings match.</p>
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
  if (el.dataset.type === 'list') return [...new Set(el.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return el.value;
}

function queueSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(draft);
    const s = $('#save-state');
    if (s) s.textContent = 'Saved.';
  }, 250);
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
  mountJobs($('#sheet-jobs'), draft, queueSave);
  mountTracking($('#sheet-tracking'), draft, queueSave);
  mountShippingFolders($('#sheet-ship-folders'), draft, queueSave);
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

function showPage(id) {
  page = PAGES[id] ? id : 'display';
  query = '';
  const q = $('#set-q');
  if (q) q.value = '';
  for (const el of $$('#settings .set-page')) el.hidden = el.dataset.page !== page;
  for (const el of $$('#settings .set-page section')) el.hidden = false;
  for (const b of $$('#settings .sheet-nav [data-goto]')) {
    if (b.dataset.goto !== page) b.removeAttribute('aria-current');
    else {
      b.setAttribute('aria-current', 'page');
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  $('#set-none').hidden = true;
  $('#settings').scrollTop = 0;
}

// Searching shows every page at once, with only the parts that mention what was typed (or all
// of a page whose name matches).
function find(text) {
  query = text.trim();
  if (!query) return showPage(page);
  const q = query.toLowerCase();
  let any = false;
  for (const p of $$('#settings .set-page')) {
    const whole = PAGES[p.dataset.page].label.toLowerCase().includes(q);
    let shown = 0;
    for (const sec of $$('section', p)) {
      sec.hidden = !whole && !sec.textContent.toLowerCase().includes(q);
      if (!sec.hidden) shown++;
    }
    p.hidden = !shown;
    any ||= shown > 0;
  }
  for (const b of $$('#settings .sheet-nav [aria-current]')) b.removeAttribute('aria-current');
  $('#set-none').hidden = any;
}

// The same choice is drawn on Cards and ticker and on the card's own page.
function setDisplay(key, mode) {
  draft.ticker[key] = mode;
  const sec = TICKER_CARDS[key].section;
  draft.show[sec] = Object.keys(TICKER_CARDS).some((k) => TICKER_CARDS[k].section === sec && tickerMode(draft, k) !== 'off');
  for (const r of $$(`#settings [data-display="${key}"]`)) r.checked = r.value === mode;
  for (const row of $$(`#settings [data-disp="${key}"]`)) row.classList.toggle('is-off', mode === 'off');
  for (const cb of $$(`#settings [data-flip-pick="${key}"]`)) cb.checked = mode === 'flip';
}

let wired = false;

function wire(dlg) {
  if (wired) return;
  wired = true;
  const onEdit = (e) => {
    const el = e.target;
    if (el.closest('#sheet-google, #sheet-gmail, #sheet-outlook, #sheet-location, #sheet-teams, #sheet-jobs, #sheet-tracking, #sheet-ship-folders')) return;
    if (el.id === 'set-q') return find(el.value);
    if (el.dataset.flipPick) {
      // Unticked, a card goes back to its own spot on the board.
      if (el.checked !== (tickerMode(draft, el.dataset.flipPick) === 'flip')) setDisplay(el.dataset.flipPick, el.checked ? 'flip' : 'card');
      queueSave();
      return;
    }
    if (el.dataset.display) {
      if (el.checked) setDisplay(el.dataset.display, el.value);
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
    } else return;
    if (el.classList.contains('swatch')) el.previousElementSibling.style.setProperty('--c', `var(--cat-${el.value})`);
    queueSave();
  };
  dlg.addEventListener('input', onEdit);
  dlg.addEventListener('change', onEdit);
  // Enter in the search box would submit the form, which closes the sheet.
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'set-q') e.preventDefault();
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
    } else if (action === 'add-group' || action === 'edit-group') {
      openGroupEditor(action === 'edit-group' ? btn.dataset.id : null, paintGroups);
    } else if (action === 'rerun') {
      draft.onboarded = false;
      queueSave();
      dlg.close();
    }
  });

  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Calendar and feed links on other hosts need Chrome's OK; this click counts as the gesture.
    const origins = [...new Set(extraOrigins([...draft.calendars.map((c) => c.url), ...draft.news.custom.map((f) => f.url)].filter(Boolean)))];
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
    if (!dirty) return;
    await saveSettings(draft);
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
