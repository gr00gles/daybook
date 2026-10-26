// Settings → Ticker: when each card is in the ticker, what the teams, headlines and markets
// cards put in it, extras that are only in the ticker, and how fast it goes. Writes
// draft.tickerOptions, each followed team's `ticker`, news.ticker and stocks.ticker, calling
// `changed()` after every edit. Other pages change what it lists (cards moved in or out of the
// ticker, teams followed), so the sheet calls the returned paint() whenever it's shown.
import { esc } from './util.js';
import { icon } from './icons.js';
import { TICKER_CARDS, TICKER_EXTRAS, TICKER_SPEEDS, onTicker } from './ticker.js';
import { SCORE_SHOWS } from './ticker-extras.js';
import { LEAGUES, inTicker } from './teams.js';
import { feedList } from './news.js';
import { stockSymbols } from './stocks.js';

const MAX_EXTRAS = 12;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SPEED_NAMES = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
const box = (attrs, label, on) => `<label class="check"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;

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

function extraFields(x, i) {
  const field = (key, label, attrs = '') =>
    `<label class="field"><span>${label}</span><input type="text" data-x-i="${i}" data-x-field="${key}" value="${esc(x[key] || '')}" spellcheck="false" autocomplete="off" ${attrs}></label>`;
  if (x.kind === 'scores')
    return `<div class="grid2">
      <label class="field"><span>League</span><select data-x-i="${i}" data-x-field="league">${Object.entries(LEAGUES).map(([k, l]) => opt(k, l.label, x.league)).join('')}</select></label>
      <label class="field"><span>Show</span><select data-x-i="${i}" data-x-field="show">${Object.entries(SCORE_SHOWS).map(([k, l]) => opt(k, l, x.show)).join('')}</select></label>
    </div>`;
  if (x.kind === 'search') return `<div class="grid2">${field('query', 'Search Google News for', 'placeholder="Buffalo Bills trade"')}${field('label', 'Label', 'placeholder="Shown before each headline"')}</div>`;
  if (x.kind === 'feed') return `<div class="grid2">${field('url', 'RSS or Atom feed', 'type="url" placeholder="https://…"')}${field('label', 'Label', 'placeholder="Shown before each headline"')}</div>`;
  return `${field('text', 'Message', 'placeholder="Trash goes out tonight"')}<div class="grid2">${field('label', 'Label', 'placeholder="Optional"')}${field('url', 'Link', 'type="url" placeholder="Optional"')}</div>`;
}

export function mountTicker(el, draft, changed) {
  const o = () => (draft.tickerOptions ||= { when: {}, extras: [], perCard: 10, speed: 'normal' });
  const extras = () => (o().extras ||= []);
  const whenOf = (target) => {
    if (target.startsWith('card:')) return ((o().when ||= {})[target.slice(5)] ||= {});
    return (extras().find((x) => `x:${x.id}` === target).when ||= {});
  };

  const paint = () => {
    const cards = Object.keys(TICKER_CARDS).filter((k) => onTicker(draft, k));
    const teams = draft.teams.list || [];
    const feeds = feedList(draft);
    const symbols = stockSymbols(draft);
    const pickedFeed = (f) => !Array.isArray(draft.news.ticker) || draft.news.ticker.includes(f.id);
    const pickedSym = (s) => !Array.isArray(draft.stocks.ticker) || draft.stocks.ticker.includes(s);
    el.innerHTML = `
  <section id="set-tkr-cards">
    <h3>Cards in the ticker</h3>
    <p class="hint">Each card you put in the ticker under <button class="linklike" type="button" data-goto="display">Cards and ticker</button> can be in it only on some days, or only at some hours. Untick days to leave them out; leave the hours empty for all day. Hours that run past midnight count for the day they start.</p>
    ${cards.length
      ? cards.map((k) => `<div class="tw-row"><span class="disp-name">${icon(TICKER_CARDS[k].icon)}<span>${esc(TICKER_CARDS[k].label)}</span></span>${whenEditor(`card:${k}`, o().when?.[k])}</div>`).join('')
      : '<p class="quiet">No cards are in the ticker. Extras below still are.</p>'}
  </section>
  <section id="set-tkr-picks">
    <h3>What the cards put in</h3>
    <p class="hint">Show fewer things in the ticker than on the card. These only matter while the card is in the ticker.</p>
    ${teams.length
      ? `<h4 class="tkr-sub">Teams</h4><div class="topics">${teams.map((t, i) => box(`data-tkr-team="${i}"`, t.name, inTicker(t))).join('')}</div>`
      : ''}
    ${feeds.length
      ? `<h4 class="tkr-sub">Headlines</h4><div class="topics">${feeds.map((f) => box(`data-tkr-feed="${esc(f.id)}"`, f.label, pickedFeed(f))).join('')}</div>`
      : ''}
    ${symbols.length && draft.stocks.key
      ? `<h4 class="tkr-sub">Markets</h4><div class="topics">${symbols.map((s) => box(`data-tkr-sym="${esc(s)}"`, s, pickedSym(s))).join('')}</div>`
      : ''}
    ${!teams.length && !feeds.length && !(symbols.length && draft.stocks.key) ? '<p class="quiet">Follow teams, pick headlines or add stocks to choose from them here.</p>' : ''}
  </section>
  <section id="set-tkr-extras">
    <h3>Extras</h3>
    <p class="hint">Things only the ticker shows, each on its own days and hours, taking turns with the cards. <strong>Live scores</strong> follows a whole league from ESPN: every game being played with its score, or all of the day’s games. With nothing on, they stay out of the ticker. A <strong>news search</strong> shows the last two days of headlines from Google News, a <strong>feed</strong> any RSS or Atom feed, and a <strong>message</strong> a line of your own.</p>
    ${extras()
      .map(
        (x, i) => `<div class="cal-row tx-row">
        <div class="row tx-head"><span class="disp-name">${icon(TICKER_EXTRAS[x.kind]?.icon || 'star')}<span>${esc(TICKER_EXTRAS[x.kind]?.label || 'Extra')}</span></span>
          ${box(`data-x-i="${i}" data-x-field="on"`, 'On', x.on !== false)}
          <button class="icon-btn" type="button" data-x-remove="${i}" aria-label="Remove">${icon('close')}</button></div>
        ${extraFields(x, i)}
        ${whenEditor(`x:${x.id}`, x.when)}
      </div>`,
      )
      .join('')}
    ${extras().length < MAX_EXTRAS
      ? `<div class="row wrap tx-add">${Object.entries(TICKER_EXTRAS)
          .map(([k, t]) => `<button class="btn small" type="button" data-x-add="${k}">${icon('plus')}${esc(t.label)}</button>`)
          .join('')}</div>`
      : `<p class="hint">That’s the most extras (${MAX_EXTRAS}). Remove one to add another.</p>`}
  </section>
  <section id="set-tkr-motion">
    <h3>Speed and length</h3>
    <div class="grid2">
      <label class="field"><span>How fast it crawls</span><select data-tkr-opt="speed">${Object.keys(TICKER_SPEEDS).map((k) => opt(k, SPEED_NAMES[k], o().speed || 'normal')).join('')}</select></label>
      <label class="field"><span>Most from each card or extra per turn</span><select data-tkr-opt="perCard" data-type="number">${[3, 5, 10, 15, 20].map((n) => opt(n, String(n), o().perCard || 10)).join('')}</select></label>
    </div>
    <p class="hint">Live scores take up to 24, so a full Sunday fits.</p>
  </section>`;
  };

  // A pick list ticked in full is stored as null, so later topics and symbols start in it.
  const pickList = (attr, all) => {
    const on = [...el.querySelectorAll(`[${attr}]`)].filter((c) => c.checked).map((c) => c.getAttribute(attr));
    return on.length === all.length ? null : on;
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
    } else if (t.dataset.tkrTeam) {
      const team = draft.teams.list[Number(t.dataset.tkrTeam)];
      if (team) team.ticker = t.checked;
    } else if (t.dataset.tkrFeed) {
      draft.news.ticker = pickList('data-tkr-feed', feedList(draft));
    } else if (t.dataset.tkrSym) {
      draft.stocks.ticker = pickList('data-tkr-sym', stockSymbols(draft));
    } else if (t.dataset.xField) {
      const x = extras()[Number(t.dataset.xI)];
      if (!x) return;
      x[t.dataset.xField] = t.type === 'checkbox' ? t.checked : t.value.trim();
    } else if (t.dataset.tkrOpt) {
      o()[t.dataset.tkrOpt] = t.dataset.type === 'number' ? Number(t.value) : t.value;
    } else return;
    changed();
  };
  el.addEventListener('input', edit);
  el.addEventListener('change', edit);

  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-x-add]');
    const remove = e.target.closest('[data-x-remove]');
    if (add) {
      const kind = add.dataset.xAdd;
      const x = { id: Date.now().toString(36), kind, on: true, label: '', when: {} };
      // Scores start as the games being played on Sundays; change either.
      if (kind === 'scores') Object.assign(x, { league: 'nfl', show: 'live', when: { days: [0] } });
      extras().push(x);
    } else if (remove) {
      extras().splice(Number(remove.dataset.xRemove), 1);
    } else return;
    changed();
    paint();
    if (add) el.querySelector('.tx-row:last-of-type input[type="text"], .tx-row:last-of-type select')?.focus();
  });

  paint();
  return { paint };
}
