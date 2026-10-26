// Extras: things that are only in the ticker, set up under Settings → Ticker, each on its own
// days and hours (ticker.js). Live scores for a whole league from ESPN's public scoreboard, a
// Google News search, any RSS or Atom feed, or a message of your own. Outside its days and hours
// an extra fetches nothing.
import { cached, local, getJSON, fmtTime, relTime, startOfDay, addDays } from './util.js';
import { fetchFeed } from './news.js';
import { LEAGUES } from './teams.js';
import { setTicker, liveExtras, extraKey } from './ticker.js';

const API = 'https://site.api.espn.com/apis/site/v2/sports';

// What a scores extra shows: only games being played, or all of today's, live ones first.
export const SCORE_SHOWS = {
  live: 'Only games being played',
  today: 'All of today’s games',
};

const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

function parseGames(events) {
  return (events || []).flatMap((ev) => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === 'home');
    const away = comp?.competitors?.find((c) => c.homeAway === 'away');
    const start = Date.parse(comp?.date || ev.date);
    const st = comp?.status?.type || ev.status?.type || {};
    if (!home || !away || !Number.isFinite(start) || /CANCEL|POSTPONED/.test(st.name || '')) return [];
    const side = (c) => ({ abbr: c.team?.abbreviation || c.team?.shortDisplayName || '?', score: c.score ?? '' });
    const b = comp.broadcasts?.[0];
    return [{
      id: String(ev.id),
      start,
      state: st.state || 'pre',
      detail: st.shortDetail || '',
      home: side(home),
      away: side(away),
      tv: b?.names?.[0] || b?.media?.shortName || '',
      link: ev.links?.find((l) => l.rel?.includes('summary'))?.href || '',
    }];
  });
}

// Today's games, and before 4 in the morning last night's too, for one still going.
async function fetchScores(league) {
  const now = Date.now();
  const days = [now, ...(new Date(now).getHours() < 4 ? [addDays(now, -1)] : [])];
  const pages = await Promise.all(days.map((d) => getJSON(`${API}/${LEAGUES[league].path}/scoreboard?dates=${ymd(d)}`)));
  const seen = new Map();
  for (const g of pages.flatMap((p) => parseGames(p.events))) seen.set(g.id, g);
  return [...seen.values()];
}

const ORDER = { in: 0, pre: 1, post: 2 };

function scoreItems(x, games, S) {
  const today = startOfDay();
  const label = LEAGUES[x.league].label;
  return games
    .filter((g) => (x.show === 'today' ? g.state === 'in' || (g.start >= today && g.start < addDays(today, 1)) : g.state === 'in'))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.start - b.start)
    .map((g) => ({
      tag: label,
      title: g.state === 'pre' ? `${g.away.abbr} at ${g.home.abbr}` : `${g.away.abbr} ${g.away.score}, ${g.home.abbr} ${g.home.score}`,
      meta: g.state === 'pre' ? [fmtTime(g.start, S.clock24), g.tv].filter(Boolean).join(' · ') : g.detail,
      tone: g.state === 'in' ? 'now' : '',
      plain: true,
      href: g.link || `https://www.espn.com/${LEAGUES[x.league].path.split('/')[1]}/scoreboard`,
    }));
}

const searchUrl = (q) => `https://news.google.com/rss/search?${new URLSearchParams({ q: `${q} when:2d`, hl: 'en-US', gl: 'US', ceid: 'US:en' })}`;

const headlineItems = (x, items) =>
  (items || []).map((n) => ({ tag: x.label || n.source || '', title: n.title, meta: n.at ? relTime(n.at) : '', href: n.url }));

// Every minute while a game is on or about to start, else every 15.
const scoresAge = (games, now = Date.now()) =>
  (games || []).some((g) => g.state === 'in' || (g.state === 'pre' && Math.abs(g.start - now) < 30 * 60e3)) ? 60e3 : 15 * 60e3;

async function refreshOne(S, x, force) {
  const key = extraKey(x);
  if (x.kind === 'text') {
    const text = (x.text || '').trim();
    setTicker(key, text ? [{ tag: x.label || '', title: text, href: x.url || '', newTab: false }] : []);
    return;
  }
  if (x.kind === 'scores') {
    if (!LEAGUES[x.league]) return setTicker(key, []);
    const sig = ymd(Date.now());
    const stored = await local.get(`cache:tx:scores:${x.league}`);
    cached({
      key: `tx:scores:${x.league}`,
      sig,
      maxAge: scoresAge(stored?.sig === sig ? stored.data : null),
      force,
      fetch: () => fetchScores(x.league),
      render: (games) => setTicker(key, scoreItems(x, games || [], S), 24),
    });
    return;
  }
  const url = x.kind === 'search' ? ((x.query || '').trim() && searchUrl(x.query.trim())) : (x.url || '').trim();
  if (!url) return setTicker(key, []);
  cached({
    key: `tx:${x.id}`,
    sig: url,
    maxAge: 20 * 60e3,
    force,
    fetch: () => fetchFeed(url),
    render: (items) => setTicker(key, headlineItems(x, items)),
  });
}

// Called with the rest of the page's refreshes, about once a minute: extras that are on now load
// (each at its own pace); ones that aren't drop out of the ticker.
export function refreshExtras(S, force = false) {
  const on = new Set();
  for (const x of liveExtras(S)) {
    on.add(x.id);
    refreshOne(S, x, force);
  }
  for (const x of S.tickerOptions?.extras || []) if (!on.has(x.id)) setTicker(extraKey(x), []);
}
