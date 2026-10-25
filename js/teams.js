// Teams you follow: each one's next game (or the live score), their games on the calendar,
// recent team news, and for a day after a game, its result at the top of the page. Schedules come from ESPN's public site API, which needs no key;
// news comes from a Google News search feed for each team.
import { $, esc, cached, hash, getJSON, local, fmtTime, relTime, updatedText, errorText, safeUrl, startOfDay, addDays } from './util.js';
import { fetchFeed } from './news.js';
import { icon } from './icons.js';
import { setTicker, offBoard } from './ticker.js';

const API = 'https://site.api.espn.com/apis/site/v2/sports';

// `hours` is how long a game takes on the calendar.
export const LEAGUES = {
  nfl: { label: 'NFL', path: 'football/nfl', hours: 3.5 },
  cfb: { label: 'College football', path: 'football/college-football', hours: 3.5, college: 'football' },
  nba: { label: 'NBA', path: 'basketball/nba', hours: 2.5 },
  wnba: { label: 'WNBA', path: 'basketball/wnba', hours: 2 },
  cbb: { label: 'Men’s college basketball', path: 'basketball/mens-college-basketball', hours: 2, college: 'basketball' },
  mlb: { label: 'MLB', path: 'baseball/mlb', hours: 3 },
  nhl: { label: 'NHL', path: 'hockey/nhl', hours: 2.5 },
  mls: { label: 'MLS', path: 'soccer/usa.1', hours: 2 },
};

export const MAX_TEAMS = 8;

const logoOf = (t) => t?.logos?.[0]?.href || t?.logo || '';
// ESPN's own logo files, for a team listed without one: by abbreviation in the pro leagues, by
// id for colleges and soccer.
const LOGO_DIRS = { nfl: 'nfl', nba: 'nba', wnba: 'wnba', mlb: 'mlb', nhl: 'nhl', cfb: 'ncaa', cbb: 'ncaa', mls: 'soccer' };
function cdnLogo(league, t) {
  const dir = LOGO_DIRS[league];
  const key = dir === 'ncaa' || dir === 'soccer' ? t?.id : (t?.abbreviation || t?.abbr || '').toLowerCase();
  return dir && key ? `https://a.espncdn.com/i/teamlogos/${dir}/500/${encodeURIComponent(key)}.png` : '';
}
const teamLogo = (t) => t.logo || cdnLogo(t.league, t);
const hex = (c) => (/^[0-9a-f]{6}$/i.test(c || '') ? `#${c}` : '');
const followed = (S) => (S.teams?.list || []).filter((t) => LEAGUES[t.league] && t.id);
const teamUrl = (t) => `https://www.google.com/search?q=${encodeURIComponent(`${t.name} schedule`)}`;

// ---- Schedules ---------------------------------------------------------------------

function scoreOf(c) {
  const s = c?.score;
  const v = s && typeof s === 'object' ? (s.displayValue ?? s.value) : s;
  return v == null || v === '' ? null : String(v);
}

function parseGame(ev, team) {
  const comp = ev.competitions?.[0];
  const us = comp?.competitors?.find((c) => String(c.id ?? c.team?.id) === String(team.id));
  const them = comp?.competitors?.find((c) => c !== us);
  if (!us || !them) return null;
  const start = Date.parse(comp.date || ev.date);
  const st = comp.status?.type || ev.status?.type || {};
  if (!Number.isFinite(start) || /CANCEL|POSTPONED/.test(st.name || '')) return null;
  const b = comp.broadcasts?.[0];
  const rank = them.curatedRank?.current;
  return {
    id: String(ev.id),
    start,
    tbd: comp.timeValid === false || ev.timeValid === false,
    home: us.homeAway === 'home',
    neutral: Boolean(comp.neutralSite),
    opp: {
      name: them.team?.displayName || 'TBD',
      short: them.team?.shortDisplayName || them.team?.displayName || 'TBD',
      logo: logoOf(them.team) || cdnLogo(team.league, them.team),
      rank: rank >= 1 && rank <= 25 ? rank : null,
    },
    state: st.state || 'pre', // pre, in or post
    detail: st.shortDetail || '',
    us: scoreOf(us),
    them: scoreOf(them),
    won: us.winner === true ? true : them.winner === true ? false : null,
    tv: b?.media?.shortName || b?.names?.[0] || '',
    venue: [comp.venue?.fullName, comp.venue?.address?.city].filter(Boolean).join(', '),
    note: comp.notes?.[0]?.headline || '',
    link: ev.links?.find((l) => l.rel?.includes('summary'))?.href || '',
  };
}

async function fetchSchedule(team) {
  const base = `${API}/${LEAGUES[team.league].path}/teams/${encodeURIComponent(team.id)}/schedule`;
  // The regular season and the postseason (bowls, playoffs) are separate lists.
  const pages = await Promise.allSettled([getJSON(`${base}?seasontype=2`), getJSON(`${base}?seasontype=3`)]);
  if (pages.every((p) => p.status === 'rejected')) throw pages[0].reason;
  const ok = pages.filter((p) => p.status === 'fulfilled').map((p) => p.value);
  const info = ok[0]?.team || {};
  const games = new Map();
  for (const page of ok) for (const ev of page.events || []) {
    const g = parseGame(ev, team);
    if (g) games.set(g.id, g);
  }
  return {
    record: info.recordSummary || '',
    standing: info.standingSummary || '',
    games: [...games.values()].sort((a, b) => a.start - b.start),
  };
}

// The game a team's row leads with: one being played, one that ended in the last 12 hours,
// or the next one.
function featured(games, now = Date.now()) {
  return (
    games.find((g) => g.state === 'in') ||
    games.filter((g) => g.state === 'post' && now - g.start < 12 * 3600e3).pop() ||
    games.find((g) => g.state === 'pre' && g.start + 6 * 3600e3 > now)
  );
}

// A team's last game while its result is still news: until a day after the game ended (its
// start plus the league's usual length). A game since then is the news instead.
const WIN_FOR = 24 * 3600e3;
const endOf = (g, t) => g.start + LEAGUES[t.league].hours * 3600e3;
function recentResult(t, games, now = Date.now()) {
  const g = games.filter((x) => x.state === 'post').pop();
  return typeof g?.won === 'boolean' && !games.some((x) => x.state === 'in') && now < endOf(g, t) + WIN_FOR ? g : null;
}
function recentWin(t, games, now) {
  const g = recentResult(t, games, now);
  return g?.won ? g : null;
}

// How soon to check again: often while a game is on, less often on game day, else a few hours.
function freshness(data, now = Date.now()) {
  const games = (data || []).flatMap((t) => t.games || []);
  if (games.some((g) => g.state === 'in' || (g.state === 'pre' && Math.abs(g.start - now) < 30 * 60e3))) return 2 * 60e3;
  if (games.some((g) => g.state !== 'post' && g.start - now < 12 * 3600e3 && g.start + 6 * 3600e3 > now)) return 15 * 60e3;
  return 3 * 3600e3;
}

// Calendar events for the games, for calendar.js.
function calendarGames(teams, data) {
  const seen = new Map();
  teams.forEach((t, i) => {
    for (const g of data?.[i]?.games || []) {
      const id = `game:${t.league}:${g.id}`;
      if (seen.has(id)) continue; // two teams you follow playing each other
      const d0 = startOfDay(g.start);
      seen.set(id, {
        id,
        title: `${t.short} ${g.home || g.neutral ? 'vs' : 'at'} ${g.opp.short}${g.tbd ? ' (time TBA)' : ''}`,
        start: g.tbd ? d0 : g.start,
        end: g.tbd ? addDays(d0, 1) : g.start + LEAGUES[t.league].hours * 3600e3,
        allDay: g.tbd,
        location: '',
        join: '',
        link: g.link || teamUrl(t),
        color: hex(t.color) || 1,
        calName: t.name,
        logo: teamLogo(t),
        // The month calendar shows a game as the two logos.
        game: { us: teamLogo(t), them: g.opp.logo, away: !(g.home || g.neutral) },
        readOnly: true,
      });
    }
  });
  return [...seen.values()];
}

// ---- Card --------------------------------------------------------------------------

function dayText(t) {
  const days = Math.round((startOfDay(t) - startOfDay()) / 86400e3);
  if (days === 0) return new Date(t).getHours() >= 17 ? 'Tonight' : 'Today';
  if (days === 1) return 'Tomorrow';
  return `in ${days} days`;
}

const resultText = (g) => `${g.won === true ? 'W' : g.won === false ? 'L' : 'T'} ${g.us}–${g.them}`;
const oppText = (g) => `${g.home || g.neutral ? 'vs' : 'at'} ${g.opp.rank ? `#${g.opp.rank} ` : ''}${g.opp.short}`;
const img = (src, cls, size) =>
  src ? `<img class="${cls}" src="${esc(safeUrl(src))}" alt="" width="${size}" height="${size}" loading="lazy">` : `<span class="${cls} none"></span>`;

function teamRow(t, info, S) {
  const now = Date.now();
  const games = info?.games || [];
  const g = featured(games, now);
  const win = S.teams.wins !== false ? recentWin(t, games, now) : null;
  const last = games.filter((x) => x.state === 'post' && x !== g).pop();
  const lastText = last && `${last === win ? `Won ${last.us}–${last.them}` : `Last: ${resultText(last)}`} ${last.home || last.neutral ? 'vs' : 'at'} `;
  const meta = [info?.record, info?.standing].filter(Boolean).map(esc);
  if (last) {
    const text = `${esc(lastText)}${img(last.opp.logo, 'tm-meta-logo', 14)}${esc(`${last.opp.rank ? `#${last.opp.rank} ` : ''}${last.opp.short}`)}`;
    meta.push(last === win ? `<span class="tm-won">${text}</span>` : text);
  }
  let main;
  if (!info) {
    main = `<p class="tm-none">Couldn’t load the schedule right now.</p>`;
  } else if (!g) {
    main = `<p class="tm-none">No upcoming games on the schedule.</p>`;
  } else {
    let when;
    let side;
    if (g.state === 'in') {
      when = `<span class="tm-live">Live</span>${esc(g.detail)}`;
      side = `<span class="tm-score">${esc(g.us ?? '0')}–${esc(g.them ?? '0')}</span>`;
    } else if (g.state === 'post') {
      when = `${g === win ? '<span class="tm-win">Win</span>' : ''}${esc(`Final${g.detail && g.detail !== 'Final' ? ` (${g.detail})` : ''}`)}`;
      side = `<span class="tm-score ${g.won ? 'won' : g.won === false ? 'lost' : ''}">${esc(resultText(g))}</span>`;
    } else {
      const date = new Date(g.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      when = esc([date, g.tbd ? 'Time TBA' : fmtTime(g.start, S.clock24), g.tv].filter(Boolean).join(' · '));
      side = `<span class="tm-count">${esc(dayText(g.start))}</span>`;
    }
    const where = [g.note, g.venue].filter(Boolean).join(' · ');
    main = `<a class="tm-game" href="${esc(safeUrl(g.link || teamUrl(t)))}" title="${esc(where)}">
      <span class="tm-logos">${img(teamLogo(t), 'tm-logo', 32)}<span class="tm-at">${g.home || g.neutral ? 'vs' : '@'}</span>${img(g.opp.logo, 'tm-logo', 32)}</span>
      <span class="tm-info"><span class="tm-title">${esc(`${t.short} ${oppText(g)}`)}</span><span class="tm-when">${when}</span></span>
      ${side}
    </a>`;
  }
  // A win wears the team's color for a day.
  return `<li class="team${win ? ' won' : ''}"${win ? ` style="--c: ${hex(t.color) || 'var(--good)'}"` : ''}>
    ${main}
    ${meta.length ? `<p class="tm-meta">${meta.join(' · ')}</p>` : ''}
  </li>`;
}

function renderCard(S, teams, data, meta) {
  $('#teams-updated').textContent = meta.error ? "couldn't refresh" : updatedText(meta.at);
  const body = $('#teams-body');
  if (!data) {
    body.innerHTML = `<p class="notice warn">Schedules aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p>`;
    return;
  }
  body.innerHTML = `<ol class="teams">${teams.map((t, i) => teamRow(t, data[i], S)).join('')}</ol>`;
  const now = Date.now();
  const results = S.teams.wins !== false ? teams.map((t, i) => [t, recentResult(t, data[i]?.games || [], now)]).filter(([, g]) => g) : [];
  const wins = results.filter(([, g]) => g.won);
  const item = (t, g, win) => {
    const date = new Date(g.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const meta =
      g.state === 'in'
        ? `Live · ${g.us ?? 0}–${g.them ?? 0}${g.detail ? ` · ${g.detail}` : ''}`
        : g.state === 'post'
          ? `${win ? 'Win' : 'Final'} · ${resultText(g)}`
          : [date, g.tbd ? 'Time TBA' : fmtTime(g.start, S.clock24), g.tv].filter(Boolean).join(' · ');
    return {
      tag: t.short,
      pair: { us: teamLogo(t), them: g.opp.logo, sep: g.home || g.neutral ? 'vs' : '@' },
      title: `${g.opp.rank ? `#${g.opp.rank} ` : ''}${g.opp.short}`,
      meta,
      tone: g.state === 'in' ? 'now' : win ? 'up' : '',
      href: g.link || teamUrl(t),
    };
  };
  setTicker(
    'teams',
    teams.flatMap((t, i) => {
      const g = featured(data[i]?.games || []);
      const win = wins.find(([w]) => w === t)?.[1];
      // A win stays in the ticker for its day, ahead of the next game.
      return [win && win !== g && item(t, win, true), g && item(t, g, g === win)].filter(Boolean);
    }),
  );
  paintResults(results);
  // Redraw when the oldest result stops being news.
  clearTimeout(winTimer);
  const ends = results.map(([t, g]) => endOf(g, t) + WIN_FOR);
  if (ends.length) winTimer = setTimeout(() => renderCard(S, teams, data, meta), Math.min(Math.min(...ends) - now + 1000, 2 ** 31 - 1));
}

// ---- Results in the search box -----------------------------------------------------
// For a day after a game, the bubble at the end of the search box (app.js) takes a turn on it:
// the two logos and the score, green for a win and red for a loss.

let winTimer;
let paintedWins = '';

function paintResults(results) {
  const box = $('#flip');
  if (!box) return;
  const html = results
    .sort(([ta, a], [tb, b]) => endOf(b, tb) - endOf(a, ta))
    .slice(0, 3)
    .map(
      ([t, g]) => `<a class="win-face ${g.won ? 'won' : 'lost'}" href="${esc(safeUrl(g.link || teamUrl(t)))}" title="${esc(`${t.short} ${g.won ? 'win' : 'loss'}, final${g.detail && g.detail !== 'Final' ? ` (${g.detail})` : ''}: ${t.short} ${g.us}, ${g.opp.short} ${g.them}`)}" aria-label="${esc(`${t.short} ${g.won ? 'beat' : 'lost to'} ${g.opp.short} ${g.us}–${g.them}`)}">
        ${img(teamLogo(t), 'win-logo', 20)}<span class="win-vs">vs</span>${img(g.opp.logo, 'win-logo', 20)}<span class="win-score">${esc(`${g.us}–${g.them}`)}</span>
      </a>`,
    )
    .join('');
  // Unchanged: leave the faces be, so a refresh doesn't flip the bubble back.
  if (html === paintedWins) return;
  paintedWins = html;
  for (const f of box.querySelectorAll('.win-face')) f.remove();
  box.insertAdjacentHTML('beforeend', html);
}

// ---- News --------------------------------------------------------------------------

function newsQuery(t) {
  const college = LEAGUES[t.league].college;
  return `"${t.name}"${college ? ` ${college}` : ''} when:7d`;
}

const newsUrl = (t) => `https://news.google.com/rss/search?${new URLSearchParams({ q: newsQuery(t), hl: 'en-US', gl: 'US', ceid: 'US:en' })}`;

async function fetchNews(teams) {
  const lists = await Promise.allSettled(teams.map((t) => fetchFeed(newsUrl(t))));
  if (lists.every((l) => l.status === 'rejected')) throw lists[0].reason;
  const seen = new Set();
  return lists
    .flatMap((l, i) => (l.status === 'fulfilled' ? l.value.slice(0, 6).map((n) => ({ ...n, team: i })) : []))
    .filter((n) => n.title && !seen.has(n.title) && seen.add(n.title))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 6);
}

function renderNews(teams, items, meta) {
  const el = $('#teams-news');
  if (!items?.length) {
    el.innerHTML = meta.error ? `<p class="notice warn">Team news: ${esc(errorText(meta.error))}.</p>` : '';
    return;
  }
  el.innerHTML = `<h3 class="eyebrow">Team news</h3><ol class="tm-news">${items
    .map((n) => {
      const t = teams[n.team];
      return `<li><a href="${esc(safeUrl(n.url))}">${img(t?.logo, 'tm-news-logo', 16)}<span class="news-title">${esc(n.title)}</span>
        <span class="news-meta">${esc(n.source || t?.short || '')}${n.at ? ` · ${relTime(n.at)}` : ''}</span></a></li>`;
    })
    .join('')}</ol>`;
}

// ---- Refresh -----------------------------------------------------------------------

// onGames gets the games as calendar events whenever the schedules (re)load.
export async function refreshTeams(S, force = false, onGames = () => {}) {
  const card = $('#card-teams');
  const teams = followed(S);
  const off = !S.show.teams || !teams.length;
  card.hidden = off || offBoard(S, 'teams');
  if (off) {
    onGames([]);
    setTicker('teams', []);
    paintResults([]);
    return;
  }
  const sig = hash(teams.map((t) => [t.league, t.id]));
  const stored = await local.get('cache:teams');
  cached({
    key: 'teams',
    sig,
    maxAge: freshness(stored?.sig === sig ? stored.data : null),
    force,
    fetch: async () => {
      // One team failing still shows the others; that row says it couldn't load.
      const settled = await Promise.allSettled(teams.map(fetchSchedule));
      if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
      return settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
    },
    render: (data, meta) => {
      renderCard(S, teams, data, meta);
      onGames(S.teams.calendar ? calendarGames(teams, data) : []);
    },
  });
  if (S.teams.news) {
    cached({
      key: 'teams:news',
      sig: hash(teams.map(newsQuery)),
      maxAge: 30 * 60e3,
      force,
      fetch: () => fetchNews(teams),
      render: (items, meta) => renderNews(teams, items, meta),
    });
  } else {
    $('#teams-news').innerHTML = '';
  }
}

// ---- Settings ----------------------------------------------------------------------

async function leagueTeams(league) {
  const key = `cache:team-list:${league}`;
  const stored = await local.get(key);
  if (stored && Date.now() - stored.at < 7 * 86400e3) return stored.data;
  const res = await getJSON(`${API}/${LEAGUES[league].path}/teams?limit=1000`);
  const data = (res.sports?.[0]?.leagues?.[0]?.teams || [])
    .map(({ team: t }) => ({
      league,
      id: String(t.id),
      name: t.displayName,
      short: t.shortDisplayName || t.name || t.displayName,
      abbr: t.abbreviation || '',
      logo: logoOf(t),
      color: t.color || '',
    }))
    .filter((t) => t.id && t.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  await local.set(key, { at: Date.now(), data });
  return data;
}

function matches(list, q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const score = (t) => {
    const name = t.name.toLowerCase();
    if (t.abbr.toLowerCase() === s) return 0;
    if (name.startsWith(s) || t.short.toLowerCase().startsWith(s)) return 1;
    if (name.split(' ').some((w) => w.startsWith(s))) return 2;
    return name.includes(s) ? 3 : 9;
  };
  return list
    .map((t) => [score(t), t])
    .filter(([n]) => n < 9)
    .sort((a, b) => a[0] - b[0])
    .slice(0, 8)
    .map(([, t]) => t);
}

// The followed-teams list and the team finder in Settings. Writes draft.teams.list.
export function mountTeams(el, draft, changed) {
  const s = { league: 'nfl', q: '', list: null, error: '', loading: false };
  const list = () => draft.teams.list;
  const has = (t) => list().some((x) => x.league === t.league && x.id === t.id);

  const paintResults = () => {
    const box = el.querySelector('.tm-results');
    if (!box) return;
    if (s.error) {
      box.innerHTML = `<p class="notice warn">${esc(s.error)}</p>`;
      return;
    }
    if (s.loading) {
      box.innerHTML = '<p class="hint">Loading teams…</p>';
      return;
    }
    const found = s.list ? matches(s.list, s.q) : [];
    box.innerHTML = found.length
      ? found
          .map(
            (t) =>
              `<button class="tm-pick" type="button" data-t-add="${esc(t.id)}"${has(t) ? ' disabled' : ''}>${img(t.logo, 'tm-pick-logo', 20)}<span>${esc(t.name)}</span>${has(t) ? '<small>Following</small>' : icon('plus')}</button>`,
          )
          .join('')
      : s.q.trim() && s.list
        ? '<p class="hint">No team by that name.</p>'
        : '';
  };

  const paint = () => {
    const full = list().length >= MAX_TEAMS;
    el.innerHTML = `
      ${list().length
        ? `<ul class="tm-following">${list()
            .map(
              (t, i) => `<li>${img(t.logo, 'tm-pick-logo', 20)}<span>${esc(t.name)}</span><small>${esc(LEAGUES[t.league]?.label || '')}</small>
              <button class="icon-btn" type="button" data-t-remove="${i}" aria-label="Stop following ${esc(t.name)}">${icon('close')}</button></li>`,
            )
            .join('')}</ul>`
        : '<p class="hint">You’re not following any teams yet.</p>'}
      ${full
        ? `<p class="hint">That’s the most Daybook follows (${MAX_TEAMS}). Remove one to add another.</p>`
        : `<div class="row wrap tm-find">
            <label class="field narrow"><span>League</span><select data-t-league>${Object.entries(LEAGUES)
              .map(([k, l]) => `<option value="${k}"${k === s.league ? ' selected' : ''}>${esc(l.label)}</option>`)
              .join('')}</select></label>
            <label class="field"><span>Find a team</span><input type="search" data-t-q value="${esc(s.q)}" placeholder="Bills, Syracuse, Ohio State…" autocomplete="off" spellcheck="false"></label>
          </div>
          <div class="tm-results"></div>`}`;
    paintResults();
  };

  const load = async () => {
    if (s.list?.[0]?.league === s.league) return;
    s.loading = true;
    s.error = '';
    s.list = null;
    paintResults();
    const league = s.league;
    try {
      const teams = await leagueTeams(league);
      if (league !== s.league) return;
      s.list = teams;
    } catch (err) {
      if (league === s.league) s.error = `Couldn’t get the ${LEAGUES[league].label} teams from ESPN: ${errorText(err)}.`;
    }
    s.loading = false;
    paintResults();
  };

  el.addEventListener('input', (e) => {
    if (!e.target.matches('[data-t-q]')) return;
    s.q = e.target.value;
    if (!s.list && !s.loading) load();
    paintResults();
  });
  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-t-league]')) return;
    s.league = e.target.value;
    load();
  });
  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-t-add]');
    const remove = e.target.closest('[data-t-remove]');
    if (add) {
      const t = s.list?.find((x) => x.id === add.dataset.tAdd);
      if (!t || has(t) || list().length >= MAX_TEAMS) return;
      list().push(t);
      s.q = '';
    } else if (remove) {
      list().splice(Number(remove.dataset.tRemove), 1);
    } else return;
    changed();
    paint();
    el.querySelector('[data-t-q]')?.focus();
  });
  paint();
}
