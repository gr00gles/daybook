// Everything the page can be told lives here. Saved to chrome.storage.sync so it follows
// your Chrome profile; tokens and cached data stay in chrome.storage.local on this machine.
import { MICROSOFT_CLIENT_ID } from '../config.js';

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
  claude: { label: 'Claude', bang: 'c', url: 'https://claude.ai/new?q=%s' },
  wikipedia: { label: 'Wikipedia', bang: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  amazon: { label: 'Amazon', bang: 'a', url: 'https://www.amazon.com/s?k=%s' },
  gmail: { label: 'Gmail', bang: 'e', url: 'https://mail.google.com/mail/u/0/#search/%s' },
};

export const GMAIL_FEEDS = {
  inbox: { label: 'Whole inbox', path: '' },
  primary: { label: 'Primary tab only', path: '^sq_ig_i_personal' },
  important: { label: 'Important only', path: 'important' },
};

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
  gmail: { feed: 'inbox', hidden: [] }, // every signed-in Gmail account except `hidden`
  calendars: [], // extra calendars added by iCal link
  outlook: { clientId: '', mail: true, calendar: true, color: 5 }, // clientId overrides config.js
  news: { topics: ['top', 'us', 'technology'], custom: [] },
  show: { weather: true, mail: true, calendar: true, news: true, notes: true, shortcuts: true },
};

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
  return merge(structuredClone(DEFAULTS), migrate(settings));
}

export const saveSettings = (s) => chrome.storage.sync.set({ settings: s });

export const msClientId = (S) => (S.outlook.clientId || MICROSOFT_CLIENT_ID || '').trim();

const PERSONAL_MS = /@(outlook|hotmail|live|msn|passport)\./i;
export const outlookWebUrl = (account) =>
  account && !PERSONAL_MS.test(account) ? 'https://outlook.office.com/mail/' : 'https://outlook.live.com/mail/';
