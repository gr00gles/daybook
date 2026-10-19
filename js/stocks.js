// A stock watchlist from Finnhub (free key from finnhub.io). Quotes refresh every 5 minutes
// while the US market is open and hourly otherwise.
import { $, esc, cached, hash, updatedText, errorText } from './util.js';

const API = 'https://finnhub.io/api/v1';

class KeyRejected extends Error {}

async function finnhub(key, path) {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Finnhub-Token': key } });
  if (res.status === 401 || res.status === 403) throw new KeyRejected('Finnhub didn’t accept the key');
  if (res.status === 429) throw new Error('Finnhub says too many requests; trying again soon');
  if (!res.ok) throw new Error(`Finnhub returned ${res.status}`);
  return res.json();
}

// Regular hours, 9:30–4:00 New York time on weekdays; used when Finnhub's own answer is missing.
function guessMarket(t = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !['Sat', 'Sun'].includes(parts.weekday);
  if (!weekday) return { isOpen: false, session: 'closed' };
  if (mins >= 570 && mins < 960) return { isOpen: true, session: 'regular' };
  if (mins >= 240 && mins < 570) return { isOpen: false, session: 'pre-market' };
  if (mins >= 960 && mins < 1200) return { isOpen: false, session: 'post-market' };
  return { isOpen: false, session: 'closed' };
}

async function fetchQuotes(key, symbols) {
  const [status, ...quotes] = await Promise.allSettled([
    finnhub(key, '/stock/market-status?exchange=US'),
    ...symbols.map((s) => finnhub(key, `/quote?symbol=${encodeURIComponent(s)}`)),
  ]);
  const rejected = quotes.find((q) => q.status === 'rejected' && q.reason instanceof KeyRejected);
  if (rejected) throw rejected.reason;
  if (quotes.length && quotes.every((q) => q.status === 'rejected')) throw quotes[0].reason;
  return {
    market: status.status === 'fulfilled' ? { isOpen: status.value.isOpen, session: status.value.session, holiday: status.value.holiday } : guessMarket(),
    quotes: quotes.map((q, i) => {
      const v = q.status === 'fulfilled' ? q.value : null;
      // Unknown symbols come back as all zeros.
      if (!v || (!v.c && v.d == null)) return { symbol: symbols[i], missing: true };
      return { symbol: symbols[i], price: v.c, change: v.d, pct: v.dp, high: v.h, low: v.l, open: v.o, prev: v.pc, t: v.t * 1000 };
    }),
  };
}

const money = (v) => (v == null ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 }));

function marketText(m) {
  if (m.holiday) return `Closed for ${m.holiday}`;
  if (m.isOpen) return 'Market open';
  if (m.session === 'pre-market') return 'Pre-market';
  if (m.session === 'post-market') return 'After hours';
  return 'Market closed';
}

function row(q) {
  const href = `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}`;
  if (q.missing)
    return `<li><a class="tk missing" href="${esc(href)}"><span class="tk-sym">${esc(q.symbol)}</span><span class="tk-none">No quote for this symbol</span></a></li>`;
  const dir = q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const span = q.high - q.low;
  const pos = span > 0 ? Math.min(100, Math.max(0, ((q.price - q.low) / span) * 100)) : 50;
  return `<li><a class="tk ${dir}" href="${esc(href)}" title="${esc(`${q.symbol}: day range ${money(q.low)} – ${money(q.high)}, previous close ${money(q.prev)}`)}">
    <span class="tk-sym">${esc(q.symbol)}</span>
    <span class="tk-range" aria-hidden="true"><span class="tk-dot" style="left:${pos.toFixed(1)}%"></span></span>
    <span class="tk-price">${money(q.price)}</span>
    <span class="tk-chg">${arrow}${q.change == null ? '' : money(Math.abs(q.change))} <small>${q.pct == null ? '' : `${Math.abs(q.pct).toFixed(2)}%`}</small></span>
  </a></li>`;
}

function render(data, meta) {
  const body = $('#stocks-body');
  if (!data) {
    body.innerHTML =
      meta.error instanceof KeyRejected
        ? `<div class="notice warn"><p>${esc(meta.error.message)}. Check it in Settings.</p><button class="btn small" type="button" data-open-settings="stocks">Open Settings</button></div>`
        : `<p class="notice warn">Quotes aren’t loading: ${esc(errorText(meta.error))}.</p>`;
    return;
  }
  $('#stocks-state').textContent = marketText(data.market);
  $('#stocks-state').className = `head-meta${data.market.isOpen ? ' open' : ''}`;
  $('#stocks-updated').textContent = meta.error ? "couldn't refresh" : updatedText(meta.at);
  body.innerHTML = `<ol class="tickers">${data.quotes.map(row).join('')}</ol>`;
}

export const stockSymbols = (S) =>
  [...new Set((S.stocks.symbols || []).map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9.:^=-]{1,20}$/.test(s)))].slice(0, 15);

export function refreshStocks(S, force = false) {
  const card = $('#card-stocks');
  const key = (S.stocks.key || '').trim();
  const symbols = stockSymbols(S);
  card.hidden = !S.show.stocks || !key || !symbols.length;
  if (card.hidden) return;
  return cached({
    key: 'stocks',
    sig: hash([key, symbols]),
    maxAge: (guessMarket().isOpen ? 5 : 60) * 60e3,
    force,
    fetch: () => fetchQuotes(key, symbols),
    render,
  });
}
