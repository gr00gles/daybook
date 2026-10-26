// Markets: a watchlist of up to MAX_SYMBOLS, each with its name, price, change and a small chart,
// under a row of indexes (S&P 500, Nasdaq, Dow and others picked in Settings), for today or a
// longer stretch picked with the tabs at the top. Quotes and charts come from Yahoo Finance's
// chart data, which needs no key. A Finnhub key (free from finnhub.io), if you add one, stands in
// for a symbol Yahoo can't give today and tells market holidays apart. Today's quotes refresh
// every 5 minutes while the US market is open and hourly otherwise; longer charts less often.
// The ticker always gets today's.
import { $, esc, cached, hash, errorText, local, sparkline } from './util.js';
import { setTicker, offBoard } from './ticker.js';

const YAHOO = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const FINNHUB = 'https://finnhub.io/api/v1';

// The tabs on the card: how far back the charts and changes go, how fine the chart is, and how
// often (minutes) the longer ones refresh.
export const RANGES = {
  '1d': { label: '1D', name: 'today', interval: '5m' },
  '5d': { label: '5D', name: 'over 5 days', interval: '30m', every: 30 },
  '1mo': { label: '1M', name: 'over a month', interval: '1d', every: 120 },
  '6mo': { label: '6M', name: 'over 6 months', interval: '1d', every: 360 },
  '1y': { label: '1Y', name: 'over a year', interval: '1d', every: 360 },
};

// The row along the top of the card: indexes, rates, commodities and the like.
export const INDEXES = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq',
  '^DJI': 'Dow',
  '^RUT': 'Russell 2000',
  '^VIX': 'VIX',
  '^TNX': '10-yr yield',
  'CL=F': 'Oil',
  'GC=F': 'Gold',
  'BTC-USD': 'Bitcoin',
  'EURUSD=X': 'Euro',
};
// Symbols Settings suggests adding with one click.
export const POPULAR = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'VOO', 'VTI', 'SPY', 'QQQ', 'DIA'];

class KeyRejected extends Error {}
const missingError = (message = 'No quote for this symbol') => Object.assign(new Error(message), { missing: true });

// ---- Yahoo Finance ---------------------------------------------------------------------

// Up to 90 points, evenly spread, always keeping the last.
function thin(points, most = 90) {
  if (points.length <= most) return points;
  const step = (points.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => points[Math.round(i * step)]);
}

// One symbol's chart: its quote from the chart's own summary, and the closes along the way.
export function parseChart(symbol, r, range) {
  const m = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const times = r.timestamp || [];
  const points = times.map((t, i) => [t * 1000, q.close?.[i]]).filter(([, v]) => Number.isFinite(v));
  const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : points.at(-1)?.[1];
  if (!Number.isFinite(price)) throw missingError();
  // The day's change is from yesterday's close; a longer range's from the close before it starts.
  const prev = m.chartPreviousClose ?? m.previousClose ?? points[0]?.[1];
  const change = Number.isFinite(prev) ? price - prev : null;
  const day = range === '1d';
  const span = (k) => (q[k] || []).filter(Number.isFinite);
  // Today's chart runs to the closing bell, so the line grows across the day.
  const end = (m.currentTradingPeriod?.regular?.end || 0) * 1000;
  const start = points[0]?.[0];
  return {
    symbol,
    name: m.shortName || m.longName || '',
    price,
    change,
    pct: change == null || !prev ? null : (change / prev) * 100,
    prev,
    high: m.regularMarketDayHigh ?? (day && span('high').length ? Math.max(...span('high')) : null),
    low: m.regularMarketDayLow ?? (day && span('low').length ? Math.min(...span('low')) : null),
    yearHigh: m.fiftyTwoWeekHigh ?? null,
    yearLow: m.fiftyTwoWeekLow ?? null,
    t: (m.regularMarketTime || 0) * 1000 || points.at(-1)?.[0] || 0,
    line: thin(points).map(([t, v]) => [t, Math.round(v * 10000) / 10000]),
    until: day && start && end > start && end - start < 86400e3 ? end : null,
  };
}

async function yahoo(symbol, range) {
  const qs = new URLSearchParams({ range, interval: RANGES[range].interval, includePrePost: 'false' });
  let last;
  for (const host of YAHOO) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, { credentials: 'omit', cache: 'no-store' });
      if (res.status === 404) throw missingError();
      if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
      const r = (await res.json())?.chart?.result?.[0];
      if (!r) throw missingError();
      return parseChart(symbol, r, range);
    } catch (err) {
      last = err;
      if (err.missing) throw err;
    }
  }
  throw last;
}

// ---- Finnhub (with a key) ----------------------------------------------------------------

async function finnhub(key, path) {
  const res = await fetch(`${FINNHUB}${path}`, { headers: { 'X-Finnhub-Token': key } });
  if (res.status === 401) throw new KeyRejected('Finnhub didn’t accept the key');
  // 403: this symbol isn't on the key's plan (some exchanges are paid).
  if (res.status === 403) throw missingError('Not on your Finnhub plan');
  if (res.status === 429) throw new Error('Finnhub says too many requests; trying again soon');
  if (!res.ok) throw new Error(`Finnhub returned ${res.status}`);
  return res.json();
}

async function finnhubQuote(key, symbol) {
  const v = await finnhub(key, `/quote?symbol=${encodeURIComponent(symbol)}`);
  // Unknown symbols come back as all zeros.
  if (!v || (!v.c && v.d == null)) throw missingError();
  return { symbol, name: '', price: v.c, change: v.d, pct: v.dp, high: v.h, low: v.l, prev: v.pc, t: v.t * 1000, line: [] };
}

// Yahoo first; for today, Finnhub stands in when Yahoo can't be reached.
async function quote(key, symbol, range) {
  try {
    return await yahoo(symbol, range);
  } catch (err) {
    if (err.missing || !key || range !== '1d') throw err;
    return finnhubQuote(key, symbol);
  }
}

// ---- The market's hours -------------------------------------------------------------------

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
const nyParts = (t) => Object.fromEntries(NY.formatToParts(new Date(t)).map((p) => [p.type, p.value]));

// Regular hours, 9:30–4:00 New York time on weekdays; used when Finnhub's own answer is missing.
function guessMarket(t = Date.now()) {
  const parts = nyParts(t);
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (['Sat', 'Sun'].includes(parts.weekday)) return { isOpen: false, session: 'closed' };
  if (mins >= 570 && mins < 960) return { isOpen: true, session: 'regular' };
  if (mins >= 240 && mins < 570) return { isOpen: false, session: 'pre-market' };
  if (mins >= 960 && mins < 1200) return { isOpen: false, session: 'post-market' };
  return { isOpen: false, session: 'closed' };
}

// The moment it's h:mm in New York on the day `days` after t's day there.
function nyAt(t, days, h, min) {
  const p = nyParts(t);
  const want = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + days, h, min);
  let guess = want + 5 * 3600e3;
  for (let i = 0; i < 2; i++) {
    const g = nyParts(guess);
    guess += want - Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour), Number(g.minute));
  }
  return guess;
}

// When the market next opens: today at 9:30 if that's still ahead, else the next weekday.
function nextOpen(t = Date.now()) {
  for (let d = 0; d < 8; d++) {
    const at = nyAt(t, d, 9, 30);
    if (at > t && !['Sat', 'Sun'].includes(nyParts(at).weekday)) return at;
  }
  return null;
}

const left = (ms) => {
  const m = Math.max(1, Math.round(ms / 60e3));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

function marketText(m, clock24) {
  const now = Date.now();
  if (m.holiday) return `Closed for ${m.holiday}`;
  if (m.isOpen) return `Open · closes in ${left(nyAt(now, 0, 16, 0) - now)}`;
  const open = nextOpen(now);
  if (m.session === 'pre-market') return open ? `Pre-market · opens in ${left(open - now)}` : 'Pre-market';
  if (m.session === 'post-market') return 'After hours';
  if (!open) return 'Market closed';
  const sameDay = new Date(open).toDateString() === new Date(now).toDateString();
  const time = new Date(open).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !clock24 });
  return `Closed · opens ${sameDay ? '' : `${new Date(open).toLocaleDateString(undefined, { weekday: 'short' })} `}${time}`;
}

// ---- Loading ----------------------------------------------------------------------------

async function fetchMarkets(key, symbols, indexes, range) {
  const [status, ...rows] = await Promise.allSettled([
    key && range === '1d' ? finnhub(key, '/stock/market-status?exchange=US') : Promise.resolve(null),
    ...symbols.map((s) => quote(key, s, range)),
    ...indexes.map((s) => yahoo(s, range)),
  ]);
  const watch = rows.slice(0, symbols.length);
  const failure = watch.find((r) => r.status === 'rejected' && !r.reason?.missing)?.reason;
  if (watch.length && watch.every((r) => r.status === 'rejected')) throw failure || watch[0].reason;
  return {
    market: status.status === 'fulfilled' && status.value ? { isOpen: status.value.isOpen, session: status.value.session, holiday: status.value.holiday } : null,
    keyNote: status.status === 'rejected' && status.reason instanceof KeyRejected ? status.reason.message : '',
    quotes: watch.map((r, i) =>
      r.status === 'fulfilled' ? r.value : r.reason?.missing ? { symbol: symbols[i], missing: true, note: r.reason.message } : { symbol: symbols[i], failed: true },
    ),
    indexes: rows.slice(symbols.length).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
  };
}

// ---- Drawing --------------------------------------------------------------------------------

// Prices under a dollar get four places; so does a change in one (`of` is the price).
const money = (v, of = v) =>
  v == null || !Number.isFinite(v) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(of) < 1 ? 4 : 2 });
const dirOf = (q) => (q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat');
const arrowOf = (q) => ({ up: '▲', down: '▼' })[dirOf(q)] || '';
const pctText = (q) => (q.pct == null ? '' : `${Math.abs(q.pct).toFixed(2)}%`);
const quoteUrl = (symbol) => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;

function chart(q, range) {
  if (!q.line?.length) return '';
  const times = q.line.map(([t]) => t);
  const span = q.until ? [times[0], Math.max(times.at(-1), q.until)] : null;
  return sparkline(q.line.map(([, v]) => v), { times, span, base: range === '1d' ? q.prev : null });
}

function tip(q, range) {
  const sign = q.change < 0 ? '−' : '+';
  return [
    q.name ? `${q.symbol} · ${q.name}` : q.symbol,
    q.change == null ? '' : `${sign}${money(Math.abs(q.change), q.price)} (${sign}${pctText(q)}) ${RANGES[range].name}`,
    q.low != null && range === '1d' ? `Day range ${money(q.low)} – ${money(q.high)}` : '',
    q.yearLow != null ? `52-week range ${money(q.yearLow)} – ${money(q.yearHigh)}` : '',
    q.prev != null ? `${range === '1d' ? 'Previous close' : 'Started at'} ${money(q.prev)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function row(q, range) {
  if (q.missing || q.failed) {
    const why = q.failed ? 'Couldn’t load right now' : q.note || 'No quote for this symbol';
    return `<li><a class="tk missing" href="${esc(quoteUrl(q.symbol))}"><span class="tk-id"><span class="tk-sym">${esc(q.symbol)}</span></span><span class="tk-none">${esc(why)}</span></a></li>`;
  }
  const dir = dirOf(q);
  // Where today's price sits in its 52-week range, as a thin bar under the price.
  const year = q.yearHigh > q.yearLow ? Math.min(100, Math.max(0, ((q.price - q.yearLow) / (q.yearHigh - q.yearLow)) * 100)) : null;
  return `<li><a class="tk ${dir}" href="${esc(quoteUrl(q.symbol))}" title="${esc(tip(q, range))}">
    <span class="tk-id"><span class="tk-sym">${esc(q.symbol)}</span>${q.name ? `<span class="tk-name">${esc(q.name)}</span>` : ''}</span>
    <span class="tk-chart" aria-hidden="true">${chart(q, range)}</span>
    <span class="tk-price">${money(q.price)}${year == null ? '' : `<span class="tk-year" aria-hidden="true"><span style="left:${year.toFixed(1)}%"></span></span>`}</span>
    <span class="tk-chg">${arrowOf(q)}<span class="tk-abs">${q.change == null ? '' : money(Math.abs(q.change), q.price)} </span><small>${pctText(q)}</small></span>
  </a></li>`;
}

const indexChip = (q, range) => `<a class="mk-idx ${dirOf(q)}" href="${esc(quoteUrl(q.symbol))}" title="${esc(tip(q, range))}">
    <span class="mk-idx-name">${esc(INDEXES[q.symbol] || q.name || q.symbol)}</span>
    <span class="mk-idx-val">${money(q.price)}</span>
    <span class="mk-idx-chg">${arrowOf(q)}${pctText(q)}</span>
  </a>`;

let settings = null;
let range = '1d';
let partial = false; // some quotes failed last time: try again sooner
const marketOf = new Map(); // range -> the market's state from its last load

function paintTabs() {
  $('#stocks-ranges').innerHTML = Object.entries(RANGES)
    .map(([k, r]) => `<button type="button" role="tab" class="tab${k === range ? ' on' : ''}" aria-selected="${k === range}" data-range="${k}" title="Change ${esc(r.name)}">${esc(r.label)}</button>`)
    .join('');
}

// The market's state: Finnhub's word with a key, else regular hours, unless every quote is from
// well before now (a holiday).
function marketState(data) {
  const m = data.market || guessMarket();
  const newest = Math.max(0, ...data.quotes.map((q) => q.t || 0), ...data.indexes.map((q) => (q.symbol.startsWith('^') ? q.t || 0 : 0)));
  if (!data.market && m.isOpen && newest && Date.now() - newest > 45 * 60e3) return { isOpen: false, session: 'closed' };
  return m;
}

function render(data, meta) {
  const body = $('#stocks-body');
  if (!data) {
    $('#stocks-state').textContent = '';
    body.innerHTML = `<div class="notice warn"><p>Quotes aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.${
      settings.stocks.key ? '' : ' A free Finnhub key in Settings can stand in for today’s quotes.'
    }</p><button class="btn small" type="button" data-open-settings="stocks">Open Settings</button></div>`;
    return;
  }
  const m = marketOf.get('1d') || marketState(data);
  $('#stocks-state').textContent = marketText(m, settings.clock24);
  $('#stocks-state').className = `head-meta${m.isOpen ? ' open' : ''}`;
  $('#stocks-updated').textContent = meta.error ? "couldn't refresh" : data.keyNote ? 'check the Finnhub key' : '';
  $('#stocks-updated').title = data.keyNote ? `${data.keyNote}. It’s in Settings → Markets.` : '';
  // Up to four in a column, with names; five to eight in two side by side (styles.css).
  body.innerHTML = `${data.indexes.length ? `<div class="mk-idxs">${data.indexes.map((q) => indexChip(q, range)).join('')}</div>` : ''}<ol class="tickers${data.quotes.length > 4 ? ' two' : ''}">${data.quotes.map((q) => row(q, range)).join('')}</ol>`;
}

function tickerItems(data) {
  const pick = Array.isArray(settings.stocks.ticker) ? settings.stocks.ticker : null;
  setTicker(
    'stocks',
    [...(settings.stocks.tickerIndexes !== false ? data.indexes : []), ...data.quotes]
      .filter((q) => !q.missing && !q.failed && (!pick || !data.quotes.includes(q) || pick.includes(q.symbol)))
      .map((q) => ({
        tag: INDEXES[q.symbol] || q.symbol,
        title: money(q.price),
        meta: q.pct == null ? '' : `${arrowOf(q)}${pctText(q)}`,
        tone: { up: 'up', down: 'down' }[dirOf(q)] || '',
        spark: q.line?.length > 2 ? q.line.map(([, v]) => v) : null,
        href: quoteUrl(q.symbol),
      })),
  );
}

export const MAX_SYMBOLS = 8;

export const stockSymbols = (S) =>
  [...new Set((S.stocks.symbols || []).map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9.:^=-]{1,20}$/.test(s)))].slice(0, MAX_SYMBOLS);
export const stockIndexes = (S) => (Array.isArray(S.stocks.indexes) ? S.stocks.indexes : []).filter((s) => INDEXES[s]);

// Loads one range: today's for the ticker and the market's state, the card's for the card.
function load(r, force) {
  const S = settings;
  const key = (S.stocks.key || '').trim();
  const symbols = stockSymbols(S);
  const indexes = stockIndexes(S);
  const open = guessMarket().isOpen || guessMarket(Date.now() - 3600e3).isOpen;
  return cached({
    key: `stocks:${r}`,
    sig: hash([key, symbols, indexes, r]),
    // Today's every 5 minutes while the market is open and for an hour after it closes (so the
    // closing prices replace the last ones from the day), else hourly; longer ones at their pace.
    maxAge: (r === '1d' ? (partial ? 1 : open ? 5 : 60) : RANGES[r].every) * 60e3,
    force,
    fetch: () => fetchMarkets(key, symbols, indexes, r),
    render: (data, meta) => {
      if (r === '1d') {
        partial = Boolean(data?.quotes.some((q) => q.failed));
        if (data) {
          marketOf.set('1d', marketState(data));
          tickerItems(data);
        }
      }
      if (r === range) render(data, meta);
    },
  });
}

let wired = false;
function wire() {
  wired = true;
  $('#stocks-ranges').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b || b.dataset.range === range) return;
    range = b.dataset.range;
    local.set('ui:stocksRange', range);
    paintTabs();
    $('#stocks-body').innerHTML = `<p class="quiet">Getting ${esc(RANGES[range].name)}…</p>`;
    load(range, false);
  });
}

export async function refreshStocks(S, force = false) {
  settings = S;
  const card = $('#card-stocks');
  const off = !S.show.stocks || !stockSymbols(S).length;
  card.hidden = off || offBoard(S, 'stocks');
  if (off) return setTicker('stocks', []);
  if (!wired) {
    wire();
    const saved = await local.get('ui:stocksRange');
    range = RANGES[saved] ? saved : '1d';
    local.remove('cache:stocks'); // the one list Markets kept before it had ranges
  }
  paintTabs();
  load('1d', force);
  if (range !== '1d') load(range, force);
}
