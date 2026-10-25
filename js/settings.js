// Everything the page can be told lives here. Saved to chrome.storage.sync so it follows
// your Chrome profile; tokens and cached data stay in chrome.storage.local on this machine.
import { MICROSOFT_CLIENT_ID } from '../config.js';
import { settleSections } from './ticker.js';

const GN = 'hl=en-US&gl=US&ceid=US:en';
const topic = (t) => `https://news.google.com/rss/headlines/section/topic/${t}?${GN}`;

export const NEWS_TOPICS = {
  top: { label: 'Top stories', short: 'Top', url: `https://news.google.com/rss?${GN}` },
  us: { label: 'U.S.', short: 'U.S.', url: topic('NATION') },
  world: { label: 'World', short: 'World', url: topic('WORLD') },
  business: { label: 'Business', short: 'Business', url: topic('BUSINESS') },
  technology: { label: 'Technology', short: 'Tech', url: topic('TECHNOLOGY') },
  science: { label: 'Science', short: 'Science', url: topic('SCIENCE') },
  health: { label: 'Health', short: 'Health', url: topic('HEALTH') },
  sports: { label: 'Sports', short: 'Sports', url: topic('SPORTS') },
  entertainment: { label: 'Entertainment', short: 'Culture', url: topic('ENTERTAINMENT') },
};

export const ENGINES = {
  google: { label: 'Google', bang: 'g', url: 'https://www.google.com/search?q=%s' },
  youtube: { label: 'YouTube', bang: 'y', url: 'https://www.youtube.com/results?search_query=%s' },
  maps: { label: 'Maps', bang: 'm', url: 'https://www.google.com/maps/search/%s' },
  claude: { label: 'Claude', bang: 'c', url: 'https://claude.ai/new?q=%s', ask: true },
  chatgpt: { label: 'ChatGPT', bang: 'gpt', url: 'https://chatgpt.com/?q=%s', ask: true },
  // Gemini's site takes no question in its link; js/ai-page.js types the one after #daybook-q= in.
  gemini: { label: 'Gemini', bang: 'gem', url: 'https://gemini.google.com/app#daybook-q=%s', ask: true },
  wikipedia: { label: 'Wikipedia', bang: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  amazon: { label: 'Amazon', bang: 'a', url: 'https://www.amazon.com/s?k=%s' },
  gmail: { label: 'Gmail', bang: 'e', url: 'https://mail.google.com/mail/u/0/#search/%s' },
};

// Gmail's folders Daybook can show: the whole inbox, one of its tabs, Important or Starred, each
// with the path of its unread feed (the Unread card) and its words in a Gmail search
// (Deliveries). Labels of your own go by name.
export const GMAIL_FOLDERS = {
  inbox: { label: 'Inbox (every tab)', path: '', search: 'in:inbox' },
  primary: { label: 'Primary', path: '^sq_ig_i_personal', search: 'category:primary' },
  social: { label: 'Social', path: '^sq_ig_i_social', search: 'category:social' },
  promotions: { label: 'Promotions', path: '^sq_ig_i_promo', search: 'category:promotions' },
  updates: { label: 'Updates', path: '^sq_ig_i_notification', search: 'category:updates' },
  forums: { label: 'Forums', path: '^sq_ig_i_group', search: 'category:forums' },
  important: { label: 'Important', path: 'important', search: 'is:important' },
  starred: { label: 'Starred', path: '^t', search: 'is:starred' },
};

// The folders and labels (names separated by commas) one Gmail account's unread mail comes
// from: its own choice, or the one every account had before each could have its own.
export const unreadFolders = (S, email) => S.gmail.accounts?.[email] || { folders: S.gmail.folders, labels: S.gmail.labels };
// Where Deliveries looks for shipping emails in one Gmail account: 'all' (All mail) or folders
// by key, and labels; All mail unless changed.
export const shippingFolders = (S, email) => S.packages.mail?.gmail?.[email] || { folders: ['all'], labels: '' };

// Hosts the manifest already grants. A calendar or feed elsewhere needs a runtime grant.
export const BUILT_IN_HOSTS = [
  'mail.google.com',
  'calendar.google.com',
  'outlook.live.com',
  'outlook.office365.com',
  'outlook.office.com',
  'news.google.com',
];

// Countries that use Fahrenheit.
const usesF = /-(US|LR|MM|BS|BZ|KY|PW|FM|MH)$/i.test(navigator.language || 'en-US');

export const DEFAULTS = {
  version: 2,
  onboarded: false,
  name: '',
  theme: 'system',
  clock24: false,
  units: usesF ? 'F' : 'C',
  searchEngine: 'google',
  location: { mode: 'auto', name: '', lat: null, lon: null },
  google: { calendars: null }, // null: the calendars Google Calendar itself shows
  // Every signed-in Gmail account except `hidden`. Each one shows unread mail from its own
  // folders and labels (accounts, by address: { folders, labels }); one without its own choice
  // uses `folders` and `labels`, the inbox unless changed. Labels go by name, separated by commas.
  gmail: { folders: ['inbox'], labels: '', accounts: {}, hidden: [] },
  calendars: [], // extra calendars added by iCal link
  // clientId overrides config.js; folders are Outlook folder ids, or 'inbox'.
  outlook: { clientId: '', mail: true, calendar: true, color: 5, folders: ['inbox'] },
  news: { topics: ['top', 'us', 'technology'], custom: [] },
  // Each card or top-bar part: 'card' (on the page), 'both' (and in the ticker), 'ticker' (in the
  // ticker only), 'flip' (a card taking turns in the flip card) or 'off'. `show` below follows: a section is on while any of its parts is.
  // The board starts with Today, the month, Unread, Markets, NYS jobs, Deliveries and Teams as cards, and the rest in the flip card.
  ticker: {
    weather: 'card', alerts: 'card', holidays: 'card', shortcuts: 'off', today: 'card', month: 'card', notes: 'flip', stocks: 'card', teams: 'card', news: 'flip',
    jobs: 'card', deliveries: 'card', mail: 'card', area: 'flip', youtube: 'flip',
  },
  board: 2, // which default board (card or flip card for each) these settings have had
  youtube: { hideShorts: true },
  flip: { every: 20 }, // seconds between turns of the flip card; 0 turns only by hand
  travel: { buffer: 5, tomtomKey: '' }, // minutes of slack before leaving; TomTom adds live traffic
  stocks: { key: '', symbols: ['SPY', 'QQQ', 'DIA'] }, // Finnhub key; the card stays hidden without one
  // Whether shipping emails count, where they're looked for (see shippingFolders; for Outlook,
  // folder ids or 'all' for the whole mailbox), whether carriers' tracking pages are read for
  // status and Amazon's order pages for what's in the box (amazon.js), and packages added by
  // hand ({ number, name, added }).
  packages: { fromMail: true, mail: { gmail: {}, outlook: ['all'] }, checkSites: true, amazonPages: true, tracked: [] },
  area: { key: '', radius: 25, days: 14, kinds: ['music', 'arts', 'other'] }, // Ticketmaster key; radius in miles or km by units
  holidays: { choices: {} }, // holiday key -> shown or not, for the ones changed from how they start
  teams: { list: [], calendar: true, news: true, wins: true }, // teams you follow; the card stays hidden without one
  // StateJobsNY: days back (-1 yesterday only, 0 from/to), the options of the site's own search
  // (empty for any), and rules of your own, each { field: a column on the site or 'any', op, value }.
  jobs: {
    days: 3, from: '', to: '',
    search: {
      keyword: '', title: '', jclass: '', agency: '', helps: '', b55: '', internship: '',
      flex: [], categories: [], regions: [], employment: '', gradeOp: 'gt', grade: '', salary: '',
    },
    rules: [],
  },
  show: {
    weather: true, mail: true, calendar: true, news: true, notes: true, shortcuts: true, youtube: true,
    alerts: true, sky: true, travel: true, packages: true, stocks: true, companies: true, teams: true, area: true, jobs: true,
  },
};

// Puts each card that's on the board, as a card or in the flip card, where the default board has
// it. Cards in the ticker or off stay as they are.
export function defaultBoard(s) {
  for (const [k, mode] of Object.entries(DEFAULTS.ticker))
    if (['card', 'flip'].includes(mode) && ['card', 'flip'].includes(s.ticker[k])) s.ticker[k] = mode;
  s.board = DEFAULTS.board;
  return s;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (isObj(v) && isObj(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

// Version 1 kept Gmail as a list of account numbers and pre-filled Google calendars that
// needed secret links. Sign-in replaces both.
function migrate(saved) {
  if (!saved || saved.version >= 2) return saved;
  const s = { ...saved, version: 2 };
  if (Array.isArray(s.gmail)) s.gmail = { feed: s.gmail[0]?.feed === 'important' ? 'important' : s.gmail[0]?.feed === 'primary' ? 'primary' : 'inbox', hidden: [] };
  if (Array.isArray(s.calendars)) s.calendars = s.calendars.filter((c) => !c.googleId);
  return s;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const s = merge(structuredClone(DEFAULTS), migrate(settings));
  // Headlines had the ticker to themselves, set as news.style; every card can have it now.
  if (s.news.style) {
    if (!settings?.ticker?.news) s.ticker.news = s.news.style;
    delete s.news.style;
  }
  // Gmail showed one feed (inbox, primary or important); it can show several folders now.
  if (settings?.gmail?.feed && !settings.gmail.folders) s.gmail.folders = [settings.gmail.feed];
  delete s.gmail.feed;
  // Package tracking briefly went through 17TRACK, with a key; carriers' own pages need none.
  delete s.packages.trackKey;
  // NYS jobs started with a words box and a counties box; those are rules now.
  const { keywords, counties, ...jobs } = s.jobs;
  if (keywords) jobs.rules = [{ field: 'any', op: 'has', value: keywords }, ...jobs.rules];
  if (counties) jobs.rules = [...jobs.rules, { field: 'County', op: 'has', value: counties }];
  s.jobs = jobs;
  // Settings from before the default board get it once.
  if (settings && (settings.board || 0) < DEFAULTS.board) {
    defaultBoard(s);
    await saveSettings(s);
  }
  settleSections(s);
  return s;
}

export const saveSettings = (s) => chrome.storage.sync.set({ settings: s });

export const msClientId = (S) => (S.outlook.clientId || MICROSOFT_CLIENT_ID || '').trim();

const PERSONAL_MS = /@(outlook|hotmail|live|msn|passport)\./i;
export const outlookWebUrl = (account) =>
  account && !PERSONAL_MS.test(account) ? 'https://outlook.office.com/mail/' : 'https://outlook.live.com/mail/';
