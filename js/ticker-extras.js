// Extras: things that are only in the ticker, set up under Settings → Ticker, each on its own
// days and hours (ticker.js). Outside its days and hours an extra fetches nothing. Each kind of
// extra is one entry of KINDS below: how to describe it in Settings, how often it refreshes
// (minutes), and how it loads its items for the ticker. Most need no key:
//   sports  live scores, news and standings for a league, and golf leaderboards, from ESPN
//   money   crypto prices (CoinGecko) and currency rates (Frankfurter, the European Central Bank's)
//   charts  Apple's top songs, albums, podcasts, apps, books and movies
//   tech    the Hacker News front page
//   world   rocket launches (Launch Library), earthquakes (USGS), TV tonight (TVMaze), and
//           Wikipedia's today in history, most read and in the news
//   yours   a Google News search, any RSS or Atom feed, a message, a countdown, world clocks
import { cached, local, getJSON, fmtTime, relTime, startOfDay, addDays } from './util.js';
import { fetchFeed } from './news.js';
import { LEAGUES } from './teams.js';
import { setTicker, liveExtras, extraKey } from './ticker.js';

const ESPN = 'https://site.api.espn.com/apis';

// ---- Choices the kinds offer in Settings ------------------------------------------------

// What a scores extra shows: only games being played, or all of today's, live ones first.
export const SCORE_SHOWS = { live: 'Only games being played', today: 'All of today’s games' };
export const STANDING_LEVELS = { 3: 'By division', 2: 'By conference', 1: 'The whole league' };
export const GOLF_TOURS = { pga: 'PGA Tour', lpga: 'LPGA Tour', eur: 'DP World Tour' };
export const COINS = {
  bitcoin: 'Bitcoin', ethereum: 'Ethereum', solana: 'Solana', ripple: 'XRP', dogecoin: 'Dogecoin', cardano: 'Cardano',
  litecoin: 'Litecoin', binancecoin: 'BNB', 'avalanche-2': 'Avalanche', chainlink: 'Chainlink', polkadot: 'Polkadot', 'shiba-inu': 'Shiba Inu',
};
export const CURRENCIES = {
  USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', JPY: 'Japanese yen', CAD: 'Canadian dollar', MXN: 'Mexican peso', CHF: 'Swiss franc',
  CNY: 'Chinese yuan', INR: 'Indian rupee', AUD: 'Australian dollar', KRW: 'South Korean won', BRL: 'Brazilian real',
};
const APPLE = 'https://rss.applemarketingtools.com/api/v2';
const ITUNES = 'https://itunes.apple.com';
export const CHARTS = {
  songs: { label: 'Top songs', url: (c) => `${APPLE}/${c}/music/most-played/25/songs.json` },
  albums: { label: 'Top albums', url: (c) => `${APPLE}/${c}/music/most-played/25/albums.json` },
  podcasts: { label: 'Top podcasts', url: (c) => `${APPLE}/${c}/podcasts/top/25/podcasts.json` },
  apps: { label: 'Top free iPhone apps', url: (c) => `${APPLE}/${c}/apps/top-free/25/apps.json` },
  paidapps: { label: 'Top paid iPhone apps', url: (c) => `${APPLE}/${c}/apps/top-paid/25/apps.json` },
  books: { label: 'Top books', url: (c) => `${APPLE}/${c}/books/top-paid/25/books.json` },
  audiobooks: { label: 'Top audiobooks', url: (c) => `${APPLE}/${c}/audio-books/top/25/audio-books.json` },
  movies: { label: 'Top movies on iTunes', url: (c) => `${ITUNES}/${c}/rss/topmovies/limit=25/json` },
  tv: { label: 'Top TV seasons on iTunes', url: (c) => `${ITUNES}/${c}/rss/toptvseasons/limit=25/json` },
};
export const WIKI_SHOWS = { onthisday: 'Today in history', mostread: 'Most read yesterday', news: 'In the news', featured: 'Today’s featured article' };
export const QUAKE_SHOWS = { big: 'Magnitude 4.5 and up, worldwide', significant: 'Significant ones this week', near: 'Magnitude 2.5 and up near you' };
export const TV_SHOWS = { tonight: 'On TV tonight', streaming: 'New on streaming today', premieres: 'Season premieres today' };
// Cities for world clocks, with where they are for their weather.
export const CITIES = {
  'Pacific/Honolulu': ['Honolulu', 21.31, -157.86],
  'America/Anchorage': ['Anchorage', 61.22, -149.9],
  'America/Los_Angeles': ['Los Angeles', 34.05, -118.24],
  'America/Denver': ['Denver', 39.74, -104.99],
  'America/Chicago': ['Chicago', 41.88, -87.63],
  'America/Mexico_City': ['Mexico City', 19.43, -99.13],
  'America/New_York': ['New York', 40.71, -74.01],
  'America/Toronto': ['Toronto', 43.65, -79.38],
  'America/Sao_Paulo': ['São Paulo', -23.55, -46.63],
  'Europe/London': ['London', 51.51, -0.13],
  'Europe/Paris': ['Paris', 48.86, 2.35],
  'Europe/Berlin': ['Berlin', 52.52, 13.4],
  'Africa/Cairo': ['Cairo', 30.04, 31.24],
  'Africa/Johannesburg': ['Johannesburg', -26.2, 28.05],
  'Europe/Moscow': ['Moscow', 55.76, 37.62],
  'Asia/Dubai': ['Dubai', 25.2, 55.27],
  'Asia/Kolkata': ['Mumbai', 19.08, 72.88],
  'Asia/Singapore': ['Singapore', 1.35, 103.82],
  'Asia/Hong_Kong': ['Hong Kong', 22.32, 114.17],
  'Asia/Shanghai': ['Shanghai', 31.23, 121.47],
  'Asia/Seoul': ['Seoul', 37.57, 126.98],
  'Asia/Tokyo': ['Tokyo', 35.68, 139.69],
  'Australia/Sydney': ['Sydney', -33.87, 151.21],
  'Pacific/Auckland': ['Auckland', -36.85, 174.76],
};

// ---- Helpers ----------------------------------------------------------------------------

const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const isoDay = (t) => new Date(t).toLocaleDateString('en-CA');
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const leagueOf = (x) => LEAGUES[x.league] || LEAGUES.nfl;
const leagueLabel = (x) => leagueOf(x).label;
// ESPN's own page for a league: its scoreboard, standings or news.
function espnPage(x, page) {
  const [sport, league] = leagueOf(x).path.split('/');
  return sport === 'soccer' ? `https://www.espn.com/soccer/${page}/_/league/${league}` : `https://www.espn.com/${league}/${page === 'news' ? '' : page}`;
}
const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const plainText = (html) => (new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
const pctMeta = (p) => (Number.isFinite(p) ? `${p > 0 ? '▲' : p < 0 ? '▼' : ''}${Math.abs(p).toFixed(2)}%` : '');
const toneOf = (p) => (p > 0 ? 'up' : p < 0 ? 'down' : '');
const price = (v, cur = 'USD') =>
  Number.isFinite(v) ? v.toLocaleString(undefined, { style: 'currency', currency: cur, minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 }) : '';
// Every n-th of a long list, keeping the last: a week of hourly prices as a small chart.
const every = (a, most = 48) => (a.length <= most ? a : a.filter((_, i) => i % Math.ceil(a.length / most) === 0 || i === a.length - 1));
const soonText = (t, S) => {
  const mins = Math.round((t - Date.now()) / 60e3);
  if (mins < -5) return 'just now';
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ` ${fmtTime(t, S.clock24)}`;
};
async function firstOf(urls) {
  let last;
  for (const url of urls) {
    try {
      return await getJSON(url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

// ---- Sports (ESPN) --------------------------------------------------------------------------

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
  const pages = await Promise.all(days.map((d) => getJSON(`${ESPN}/site/v2/sports/${LEAGUES[league].path}/scoreboard?dates=${ymd(d)}`)));
  const seen = new Map();
  for (const g of pages.flatMap((p) => parseGames(p.events))) seen.set(g.id, g);
  return [...seen.values()];
}

const ORDER = { in: 0, pre: 1, post: 2 };

function scoreItems(x, games, S) {
  const today = startOfDay();
  return games
    .filter((g) => (x.show === 'today' ? g.state === 'in' || (g.start >= today && g.start < addDays(today, 1)) : g.state === 'in'))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.start - b.start)
    .map((g) => ({
      tag: leagueLabel(x),
      title: g.state === 'pre' ? `${g.away.abbr} at ${g.home.abbr}` : `${g.away.abbr} ${g.away.score}, ${g.home.abbr} ${g.home.score}`,
      meta: g.state === 'pre' ? [fmtTime(g.start, S.clock24), g.tv].filter(Boolean).join(' · ') : g.detail,
      tone: g.state === 'in' ? 'now' : '',
      plain: true,
      href: g.link || espnPage(x, 'scoreboard'),
    }));
}

// Every minute while a game is on or about to start, else every 15.
const scoresAge = (games, now = Date.now()) =>
  (games || []).some((g) => g.state === 'in' || (g.state === 'pre' && Math.abs(g.start - now) < 30 * 60e3)) ? 1 : 15;

// A league's standings, as groups (a division, a conference or the league) of teams in order.
export function parseStandings(data) {
  const groups = [];
  const walk = (node) => {
    if (node?.standings?.entries?.length) groups.push({ name: node.abbreviation || node.shortName || node.name || '', entries: node.standings.entries });
    for (const child of node?.children || []) walk(child);
  };
  walk(data);
  return groups.map((g) => ({
    name: g.name,
    teams: g.entries
      .map((e) => {
        const stat = (...names) => {
          const s = (e.stats || []).find((x) => names.includes(x.name) || names.includes(x.type));
          return s ? { value: Number(s.value), text: s.displayValue ?? String(s.value ?? '') } : null;
        };
        const w = stat('wins')?.value;
        const l = stat('losses')?.value;
        const t = stat('ties')?.value;
        const otl = stat('otLosses', 'overtimeLosses')?.value;
        const pts = stat('points')?.value;
        const record =
          stat('overall', 'total')?.text || (Number.isFinite(w) && Number.isFinite(l) ? [w, l, otl || t || null].filter((n) => n != null && Number.isFinite(n)).join('-') : '');
        return {
          abbr: e.team?.abbreviation || e.team?.shortDisplayName || '?',
          record,
          seed: stat('playoffSeed', 'rank')?.value,
          pct: stat('winPercent', 'leagueWinPercent')?.value,
          pts,
        };
      })
      .sort((a, b) => (a.seed && b.seed ? a.seed - b.seed : 0) || (b.pts ?? b.pct ?? 0) - (a.pts ?? a.pct ?? 0)),
  }));
}

function standingItems(x, groups) {
  const top = Number(x.top) || 4;
  const soccer = leagueOf(x).path.startsWith('soccer');
  return groups.map((g) => ({
    tag: g.name || leagueLabel(x),
    title: g.teams
      .slice(0, top)
      .map((t, i) => `${soccer ? `${i + 1} ` : ''}${t.abbr} ${soccer && Number.isFinite(t.pts) ? `${t.pts}` : t.record}`)
      .join(' · '),
    plain: true,
    href: espnPage(x, 'standings'),
  }));
}

function golfItems(x, data) {
  const ev = data?.events?.find((e) => e.status?.type?.state === 'in') || data?.events?.[0];
  const comp = ev?.competitions?.[0];
  const score = (c) => (typeof c.score === 'object' ? c.score?.displayValue : c.score) ?? '';
  const players = (comp?.competitors || []).filter((c) => score(c) !== '').sort((a, b) => (a.sortOrder ?? a.order ?? 0) - (b.sortOrder ?? b.order ?? 0));
  const tour = GOLF_TOURS[x.tour] || 'Golf';
  return players.slice(0, Number(x.top) || 10).map((c, i) => {
    const thru = c.status?.thru;
    return {
      tag: `${tour} · ${c.status?.position?.displayName || i + 1}`,
      title: `${c.athlete?.shortName || c.athlete?.displayName || '?'} ${score(c)}`,
      meta: thru === 18 ? 'F' : Number.isFinite(thru) && thru > 0 ? `thru ${thru}` : c.status?.type?.shortDetail || '',
      tone: i === 0 ? 'up' : '',
      plain: true,
      href: ev?.links?.[0]?.href || `https://www.espn.com/golf/leaderboard${x.tour === 'pga' ? '' : `/_/tour/${x.tour}`}`,
    };
  });
}

// ---- Money ----------------------------------------------------------------------------------

async function fetchCrypto(x) {
  const ids = list(x.coins).filter((c) => COINS[c] || /^[a-z0-9-]+$/.test(c));
  if (!ids.length) return [];
  const qs = new URLSearchParams({ vs_currency: x.vs || 'usd', ids: ids.join(','), sparkline: 'true', price_change_percentage: '24h' });
  const coins = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?${qs}`);
  return (coins || []).map((c) => ({
    id: c.id,
    symbol: String(c.symbol || '').toUpperCase(),
    name: c.name,
    image: c.image || '',
    price: c.current_price,
    pct: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
    spark: every((c.sparkline_in_7d?.price || []).filter(Number.isFinite)).map((v) => Number(v.toPrecision(6))),
  }));
}

const cryptoItems = (x, coins) =>
  coins.map((c) => ({
    tag: c.symbol,
    img: c.image,
    title: price(c.price, (x.vs || 'usd').toUpperCase()),
    meta: pctMeta(c.pct),
    tone: toneOf(c.pct),
    spark: c.spark?.length > 2 ? c.spark : null,
    href: `https://www.coingecko.com/en/coins/${encodeURIComponent(c.id)}`,
  }));

// A month of daily rates from the European Central Bank, for the latest, its change and a chart.
async function fetchRates(x) {
  const base = CURRENCIES[x.base] ? x.base : 'USD';
  const to = list(x.to).filter((c) => CURRENCIES[c] && c !== base);
  if (!to.length) return null;
  const from = isoDay(addDays(Date.now(), -31));
  const qs = new URLSearchParams({ base, symbols: to.join(','), from: base, to: to.join(',') });
  const data = await firstOf([`https://api.frankfurter.dev/v1/${from}..?${qs}`, `https://api.frankfurter.app/${from}..?${qs}`]);
  const days = Object.keys(data?.rates || {}).sort();
  return {
    base,
    rates: to.map((c) => {
      const series = days.map((d) => data.rates[d]?.[c]).filter(Number.isFinite);
      const now = series.at(-1);
      const before = series.at(-2);
      return { code: c, rate: now, pct: Number.isFinite(before) ? ((now - before) / before) * 100 : null, spark: series };
    }).filter((r) => Number.isFinite(r.rate)),
  };
}

const rateItems = (x, data) =>
  (data?.rates || []).map((r) => ({
    tag: `${data.base} → ${r.code}`,
    title: r.rate.toLocaleString(undefined, { minimumFractionDigits: r.rate >= 100 ? 2 : 4, maximumFractionDigits: r.rate >= 100 ? 2 : 4 }),
    meta: pctMeta(r.pct),
    tone: toneOf(r.pct),
    spark: r.spark.length > 2 ? r.spark : null,
    href: google(`${data.base} to ${r.code}`),
  }));

// ---- Charts (Apple) -----------------------------------------------------------------------------

// Apple's feeds (results) and the older iTunes ones (entry), as one shape.
export function parseChart(data) {
  if (Array.isArray(data?.feed?.results))
    return data.feed.results.map((r) => ({ name: r.name, by: r.artistName || '', img: r.artworkUrl100 || '', url: r.url || '' }));
  const label = (v) => v?.label || '';
  return (data?.feed?.entry || []).map((e) => {
    const link = [].concat(e.link || []).find((l) => l?.attributes?.href)?.attributes?.href;
    return { name: label(e['im:name']) || label(e.title), by: label(e['im:artist']), img: label([].concat(e['im:image'] || []).at(-1)), url: link || label(e.id) };
  });
}

const chartItems = (x, rows) =>
  rows.map((r, i) => ({ tag: `#${i + 1}`, img: r.img, title: r.name, meta: r.by, href: r.url || google(`${r.name} ${r.by}`) }));

// ---- Tech and the world -----------------------------------------------------------------------

async function fetchHackerNews() {
  const data = await getJSON('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
  return (data?.hits || [])
    .map((h) => ({ id: h.objectID, title: h.title, url: h.url, points: h.points || 0, comments: h.num_comments || 0 }))
    .filter((h) => h.title)
    .sort((a, b) => b.points - a.points);
}

const hnItems = (x, hits) =>
  hits.map((h) => ({
    tag: 'HN',
    title: h.title,
    meta: `${h.points} points · ${h.comments} comments`,
    href: h.url || `https://news.ycombinator.com/item?id=${encodeURIComponent(h.id)}`,
  }));

// Wikipedia's feeds, from Wikipedia itself or, failing that, Wikimedia's API.
async function fetchWiki(x) {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const path = x.show === 'onthisday' ? `onthisday/selected/${mm}/${dd}` : `featured/${d.getFullYear()}/${mm}/${dd}`;
  const data = await firstOf([`https://en.wikipedia.org/api/rest_v1/feed/${path}`, `https://api.wikimedia.org/feed/v1/wikipedia/en/${path}`]);
  const page = (p) => p?.content_urls?.desktop?.page || (p?.titles?.canonical ? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.titles.canonical)}` : '');
  if (x.show === 'onthisday')
    return (data?.selected || data?.events || []).map((e) => ({ tag: String(e.year ?? ''), title: e.text, href: page(e.pages?.[0]) }));
  if (x.show === 'news') return (data?.news || []).map((n) => ({ tag: 'In the news', title: plainText(n.story), href: page(n.links?.[0]) }));
  if (x.show === 'featured')
    return data?.tfa ? [{ tag: 'Featured article', title: data.tfa.titles?.normalized || data.tfa.title, meta: data.tfa.description || '', href: page(data.tfa) }] : [];
  return (data?.mostread?.articles || [])
    .filter((a) => !/^(Main Page|Special:|Wikipedia:|Portal:|File:)/.test(a.titles?.normalized || a.title || ''))
    .map((a) => ({ tag: 'Most read', title: a.titles?.normalized || a.title, meta: a.views ? `${a.views.toLocaleString()} views` : a.description || '', href: page(a) }));
}

// Launch Library 2 (The Space Devs), in its newer shape or its older one.
async function fetchLaunches() {
  const data = await firstOf([
    'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12&mode=normal',
    'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=12&mode=normal',
  ]);
  return (data?.results || []).map((l) => {
    const [rocket, mission] = String(l.name || '').split(' | ');
    const video = (l.vid_urls || l.vidURLs || []).find((v) => v?.url)?.url;
    return {
      rocket: l.rocket?.configuration?.name || rocket || '',
      mission: l.mission?.name || mission || rocket || 'Launch',
      by: l.launch_service_provider?.abbrev || l.launch_service_provider?.name || l.lsp_name || '',
      at: Date.parse(l.net),
      status: l.status?.abbrev || '',
      where: l.pad?.location?.name || l.location || '',
      url: video || google(`${l.name} launch`),
    };
  }).filter((l) => Number.isFinite(l.at));
}

const launchItems = (x, launches, S) =>
  launches
    .filter((l) => l.at > Date.now() - 2 * 3600e3)
    .sort((a, b) => a.at - b.at)
    .map((l) => ({
      tag: l.by || 'Launch',
      title: `${l.mission}${l.rocket && l.rocket !== l.mission ? ` · ${l.rocket}` : ''}`,
      meta: `${soonText(l.at, S)}${l.status && !/^go$/i.test(l.status) ? ` · ${l.status}` : ''}`,
      tone: l.at - Date.now() < 3600e3 ? 'now' : '',
      href: l.url,
    }));

const QUAKE_FEEDS = { big: '4.5_day', significant: 'significant_week', near: '2.5_week' };
const kmBetween = (a, b, c, d) => {
  const r = Math.PI / 180;
  const h = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

async function fetchQuakes(x) {
  const data = await getJSON(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${QUAKE_FEEDS[x.show] || QUAKE_FEEDS.big}.geojson`);
  return (data?.features || []).map((f) => ({
    mag: f.properties?.mag,
    place: f.properties?.place || f.properties?.title || '',
    at: f.properties?.time,
    url: f.properties?.url || '',
    tsunami: Boolean(f.properties?.tsunami),
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
  }));
}

async function quakeItems(x, quakes, S) {
  let list = quakes.filter((q) => Number.isFinite(q.mag));
  if (x.show === 'near') {
    const home = S.location.lat != null ? S.location : await local.get('geo');
    const km = (Number(x.radius) || 500) * (S.units === 'C' ? 1 : 1.609);
    list = home?.lat != null ? list.filter((q) => kmBetween(home.lat, home.lon, q.lat, q.lon) <= km) : [];
  }
  return list
    .sort((a, b) => b.at - a.at)
    .map((q) => ({
      tag: `M${q.mag.toFixed(1)}`,
      title: q.place,
      meta: `${relTime(q.at)}${q.tsunami ? ' · tsunami alert' : ''}`,
      tone: q.mag >= 6 || q.tsunami ? 'down' : '',
      href: q.url,
    }));
}

async function fetchTv(x) {
  const day = isoDay(Date.now());
  const country = x.country || 'US';
  const [air, web] = await Promise.all([
    x.show === 'streaming' ? null : getJSON(`https://api.tvmaze.com/schedule?country=${encodeURIComponent(country)}&date=${day}`),
    x.show === 'tonight' ? null : getJSON(`https://api.tvmaze.com/schedule/web?date=${day}`),
  ]);
  const shape = (ep) => {
    const show = ep.show || ep._embedded?.show || {};
    return {
      show: show.name || '',
      channel: show.network?.name || show.webChannel?.name || ep.show?.webChannel?.name || '',
      country: show.network?.country?.code || show.webChannel?.country?.code || '',
      lang: show.language || '',
      season: ep.season,
      number: ep.number,
      at: Date.parse(ep.airstamp) || null,
      url: show.officialSite || show.url || ep.url || '',
    };
  };
  return [...(air || []).map((e) => ({ ...shape(e), web: false })), ...(web || []).map((e) => ({ ...shape(e), web: true }))].filter((e) => e.show);
}

function tvItems(x, eps, S) {
  const seen = new Set();
  const prime = (e) => {
    const h = e.at ? new Date(e.at).getHours() : 0;
    return h >= 19 && h <= 23;
  };
  return eps
    .filter((e) => {
      if (x.show === 'tonight') return !e.web && prime(e);
      if (x.show === 'streaming') return e.web && (!e.lang || e.lang === 'English') && (!e.country || e.country === (x.country || 'US'));
      return e.number === 1 && (!e.lang || e.lang === 'English');
    })
    .filter((e) => !seen.has(e.show) && seen.add(e.show))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, 30)
    .map((e) => ({
      tag: e.channel || 'TV',
      title: e.show,
      meta: [x.show === 'tonight' && e.at ? fmtTime(e.at, S.clock24) : '', e.season && e.number ? `S${e.season} E${e.number}` : ''].filter(Boolean).join(' · '),
      href: e.url,
    }));
}

// ---- Yours ---------------------------------------------------------------------------------------

const searchUrl = (q) => `https://news.google.com/rss/search?${new URLSearchParams({ q: `${q} when:2d`, hl: 'en-US', gl: 'US', ceid: 'US:en' })}`;

const headlineItems = (x, items) =>
  (items || []).map((n) => ({ tag: x.label || n.source || '', title: n.title, meta: x.summary ? n.summary || '' : n.at ? relTime(n.at) : '', href: n.url }));

function countdownItems(x) {
  const m = String(x.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const days = Math.round((new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - startOfDay()) / 86400e3);
  const what = (x.text || 'the day').trim();
  if (days < 0) return [];
  return [{
    tag: x.label || 'Countdown',
    title: days === 0 ? `${what} is today` : days === 1 ? `${what} is tomorrow` : `${days} days until ${what}`,
    tone: days <= 1 ? 'now' : '',
    href: x.url || '',
    newTab: false,
  }];
}

function clockItems(x, S, temps) {
  const here = new Date().toLocaleDateString('en-CA');
  return list(x.zones)
    .filter((z) => CITIES[z])
    .map((z) => {
      const now = new Date();
      const day = now.toLocaleDateString('en-CA', { timeZone: z });
      const t = temps?.[z];
      return {
        tag: CITIES[z][0],
        title: now.toLocaleTimeString(undefined, { timeZone: z, hour: 'numeric', minute: '2-digit', hour12: !S.clock24 }),
        meta: [day === here ? '' : now.toLocaleDateString(undefined, { timeZone: z, weekday: 'short' }), Number.isFinite(t) ? `${Math.round(t)}°` : ''].filter(Boolean).join(' · '),
        plain: true,
        href: google(`time in ${CITIES[z][0]}`),
      };
    });
}

// The temperature in each city, in one request.
async function fetchCityWeather(zones, units) {
  const cities = zones.filter((z) => CITIES[z]);
  if (!cities.length) return {};
  const qs = new URLSearchParams({
    latitude: cities.map((z) => CITIES[z][1]).join(','),
    longitude: cities.map((z) => CITIES[z][2]).join(','),
    current: 'temperature_2m',
    temperature_unit: units === 'C' ? 'celsius' : 'fahrenheit',
  });
  const data = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs}`);
  const rows = Array.isArray(data) ? data : [data];
  return Object.fromEntries(cities.map((z, i) => [z, rows[i]?.current?.temperature_2m]));
}

// ---- The kinds ------------------------------------------------------------------------------------
// `describe` names an extra in Settings; `every` is how often (minutes) it fetches; `load` fetches
// what it shows (kept in storage, shared with other tabs), and `items` turns that into the
// ticker's items. `local` kinds fetch nothing and are redrawn every few seconds. `most` lets one
// take more than the usual few items a turn: a Sunday's worth of scores.

export const KINDS = {
  scores: {
    describe: (x) => `${leagueLabel(x)} scores`,
    every: 15,
    sig: (x) => `scores:${x.league}`,
    load: (x) => fetchScores(x.league),
    items: scoreItems,
    most: 24,
  },
  sportsnews: {
    describe: (x) => `${leagueLabel(x)} news`,
    every: 20,
    sig: (x) => `sportsnews:${x.league}`,
    load: async (x) => (await getJSON(`${ESPN}/site/v2/sports/${leagueOf(x).path}/news?limit=20`))?.articles?.map((a) => ({
      title: a.headline || a.title,
      at: Date.parse(a.published) || null,
      url: a.links?.web?.href || a.links?.mobile?.href || '',
    })) || [],
    items: (x, rows) => rows.filter((r) => r.title).map((r) => ({ tag: leagueLabel(x), title: r.title, meta: r.at ? relTime(r.at) : '', href: r.url || espnPage(x, 'news') })),
  },
  standings: {
    describe: (x) => `${leagueLabel(x)} standings`,
    every: 180,
    sig: (x) => `standings:${x.league}:${x.level || 3}`,
    load: async (x) => parseStandings(await getJSON(`${ESPN}/v2/sports/${leagueOf(x).path}/standings?level=${Number(x.level) || 3}`)),
    items: standingItems,
  },
  golf: {
    describe: (x) => `${GOLF_TOURS[x.tour] || 'Golf'} leaderboard`,
    every: 10,
    sig: (x) => `golf:${x.tour}`,
    load: (x) => getJSON(`${ESPN}/site/v2/sports/golf/${encodeURIComponent(x.tour || 'pga')}/scoreboard`),
    items: golfItems,
  },
  crypto: {
    describe: (x) => `Crypto: ${list(x.coins).map((c) => COINS[c] || c).join(', ') || 'none picked'}`,
    every: 10,
    sig: (x) => `crypto:${list(x.coins).join(',')}:${x.vs || 'usd'}`,
    load: fetchCrypto,
    items: cryptoItems,
  },
  fx: {
    describe: (x) => `${x.base || 'USD'} in ${list(x.to).join(', ') || 'nothing picked'}`,
    every: 180,
    sig: (x) => `fx:${x.base}:${list(x.to).join(',')}`,
    load: fetchRates,
    items: rateItems,
  },
  charts: {
    describe: (x) => CHARTS[x.chart]?.label || 'Top charts',
    every: 180,
    sig: (x) => `charts:${x.chart}:${x.country || 'us'}`,
    load: async (x) => parseChart(await getJSON((CHARTS[x.chart] || CHARTS.songs).url(x.country || 'us'))),
    items: chartItems,
  },
  hn: { describe: () => 'Hacker News front page', every: 15, sig: () => 'hn', load: fetchHackerNews, items: hnItems },
  wiki: {
    describe: (x) => `Wikipedia: ${WIKI_SHOWS[x.show] || WIKI_SHOWS.onthisday}`,
    every: 180,
    sig: (x) => `wiki:${x.show}:${isoDay(Date.now())}`,
    load: fetchWiki,
    items: (x, rows) => rows,
  },
  launches: { describe: () => 'Rocket launches', every: 60, sig: () => 'launches', load: fetchLaunches, items: launchItems },
  quakes: {
    describe: (x) => `Earthquakes: ${(QUAKE_SHOWS[x.show] || QUAKE_SHOWS.big).toLowerCase()}`,
    every: 15,
    sig: (x) => `quakes:${x.show}`,
    load: fetchQuakes,
    items: quakeItems,
  },
  tv: {
    describe: (x) => TV_SHOWS[x.show] || TV_SHOWS.tonight,
    every: 180,
    sig: (x) => `tv:${x.show}:${x.country || 'US'}:${isoDay(Date.now())}`,
    load: fetchTv,
    items: tvItems,
  },
  search: {
    describe: (x) => (x.query ? `News about “${x.query}”` : 'News search'),
    every: 20,
    sig: (x) => `search:${(x.query || '').trim()}`,
    url: (x) => (x.query || '').trim() && searchUrl(x.query.trim()),
    items: headlineItems,
  },
  feed: {
    describe: (x) => x.label || (/^https?:\/\/([^/]+)/.exec(x.url || '')?.[1] ?? 'Feed'),
    every: 20,
    sig: (x) => `feed:${(x.url || '').trim()}`,
    url: (x) => (x.url || '').trim(),
    items: headlineItems,
  },
  text: { describe: (x) => (x.text ? `“${x.text}”` : 'Message'), local: true, items: (x) => ((x.text || '').trim() ? [{ tag: x.label || '', title: x.text.trim(), href: x.url || '', newTab: false }] : []) },
  countdown: { describe: (x) => `Days until ${x.text || 'a date'}`, local: true, items: countdownItems },
  clocks: {
    describe: (x) => `Clocks: ${list(x.zones).map((z) => CITIES[z]?.[0]).filter(Boolean).join(', ') || 'none picked'}`,
    local: true,
    // The temperatures come along every half hour when asked for.
    every: 30,
    sig: (x) => `clocks:${list(x.zones).join(',')}`,
    items: clockItems,
  },
};

// ---- Refreshing -----------------------------------------------------------------------------------

const temps = new Map(); // clocks extra id -> each city's temperature

async function refreshOne(S, x, force) {
  const key = extraKey(x);
  const kind = KINDS[x.kind];
  if (!kind) return setTicker(key, []);
  if (x.kind === 'clocks') {
    setTicker(key, clockItems(x, S, temps.get(x.id)));
    if (x.weather === false) return;
    cached({
      key: `tx:${x.id}`,
      sig: `${kind.sig(x)}:${S.units}`,
      maxAge: kind.every * 60e3,
      force,
      fetch: () => fetchCityWeather(list(x.zones), S.units),
      render: (t) => {
        if (!t) return;
        temps.set(x.id, t);
        setTicker(key, clockItems(x, S, t));
      },
    });
    return;
  }
  if (kind.local) return setTicker(key, kind.items(x, S));
  // Feeds and news searches share the headline reader.
  const url = kind.url?.(x);
  if (kind.url && !url) return setTicker(key, []);
  // One stored copy per extra; `sig` names what it was fetched for (and the day, for some).
  const sig = kind.sig(x);
  const stored = x.kind === 'scores' ? await local.get(`cache:tx:${x.id}`) : null;
  cached({
    key: `tx:${x.id}`,
    sig,
    maxAge: (x.kind === 'scores' ? scoresAge(stored?.sig === sig ? stored.data : null) : kind.every) * 60e3,
    force,
    fetch: () => (kind.url ? fetchFeed(url) : kind.load(x, S)),
    render: async (data) => setTicker(key, await kind.items(x, data || [], S), kind.most),
  });
}

// Called with the rest of the page's refreshes, about once a minute: extras that are on now load
// (each at its own pace); ones that aren't drop out of the ticker. Clocks and countdowns, which
// fetch nothing (but the clocks' weather), are redrawn every few seconds in between.
let ticking = null;
export function refreshExtras(S, force = false) {
  const on = new Set();
  for (const x of liveExtras(S)) {
    on.add(x.id);
    refreshOne(S, x, force);
  }
  for (const x of S.tickerOptions?.extras || []) if (!on.has(x.id)) setTicker(extraKey(x), []);
  ticking ||= setInterval(() => {
    for (const x of liveExtras(S)) if (KINDS[x.kind]?.local) setTicker(extraKey(x), x.kind === 'clocks' ? clockItems(x, S, temps.get(x.id)) : KINDS[x.kind].items(x, S));
  }, 15e3);
}
