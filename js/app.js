import { loadSettings, saveSettings, ENGINES, outlookWebUrl } from './settings.js';
import { $, $$, esc, colorVar, safeUrl, fmtTime, local } from './util.js';
import { refreshWeather, renderSun, lastWeather, todayIndex, initWeather } from './weather.js';
import { refreshMail, initMail, renderMail } from './mail.js';
import { refreshCalendars, renderAgenda, nextUp, allEvents, setGames } from './calendar.js';
import { initAlerts, refreshAlerts } from './alerts.js';
import { renderMoon, loadHolidays, renderHoliday, setHolidayChoices, setSkyOnPage } from './sky.js';
import { planTrips, tripInfo, leaveText } from './trip.js';
import { refreshStocks } from './stocks.js';
import { refreshTeams } from './teams.js';
import { initArea, refreshArea } from './area.js';
import { refreshJobs } from './jobs.js';
import { initEvents } from './events.js';
import { initDetails } from './details.js';
import { initMonth, renderMonth } from './month.js';
import { initPlaces, updatePlaces, openActivePlace } from './places.js';
import { initYouTube, refreshYouTube } from './youtube.js';
import { refreshNews, initNews, refreshTicker } from './news.js';
import { initTicker, setTicker, onTicker, offBoard, TICKER_CARDS } from './ticker.js';
import { openSettings } from './sheet.js';
import { openWelcome } from './onboarding.js';
import { msAccount } from './msauth.js';
import { icon, aiMark } from './icons.js';
import { groupTiles } from './sites.js';
import { initDeliveries } from './packages.js';
import { initAsk, ask, hasKey } from './ask.js';
import { applyLayout, initLayout } from './layout.js';
import { setCredit } from './credits.js';
import { initFlipCard } from './flipcard.js';

const S = await loadSettings();
await applyLayout();

if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
for (const [section, on] of Object.entries(S.show)) {
  for (const el of $$(`[data-section="${section}"]`)) el.toggleAttribute('hidden', !on);
}
// Any card or part of the top bar can be in the ticker under the top band as well, or instead:
// those set to the ticker only are off the page, though they still load what they show there.
for (const [key, c] of Object.entries(TICKER_CARDS)) if (offBoard(S, key)) $(`#${c.card}`).hidden = true;
// Cards set to the flip card move into it and take turns there.
initFlipCard(S);
const skyOnPage = S.show.sky && !offBoard(S, 'holidays');
// The sun's day and the moon are in the week bubble, but the moon has its own switch: without
// the weather in the top bar, it sits where the weather would be, and the hemisphere (which way
// the moon is lit) comes from the city in Settings or the last location fix.
if (skyOnPage && offBoard(S, 'weather')) {
  $('.now-weather').hidden = false;
  $('.now-weather').append($('.nw-sky'));
}
const newsCard = S.show.news && !offBoard(S, 'news');
const newsTicker = onTicker(S, 'news');
const homeLat = S.location.lat ?? (await local.get('geo'))?.lat;
$('#refresh-btn').innerHTML = icon('refresh');
$('#settings-btn').innerHTML = icon('gear');

// ---- Clock, greeting, sky ----------------------------------------------------------

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function skyPhase() {
  const now = Date.now();
  const w = lastWeather();
  let rise, set;
  if (w) {
    const i = todayIndex(w.daily);
    rise = w.daily.sunrise[i] * 1000;
    set = w.daily.sunset[i] * 1000;
  } else {
    rise = new Date().setHours(7, 0, 0, 0);
    set = new Date().setHours(18, 15, 0, 0);
  }
  const edge = 45 * 60e3;
  if (Math.abs(now - rise) < edge) return 'dawn';
  if (Math.abs(now - set) < edge) return 'dusk';
  return now > rise && now < set ? 'day' : 'night';
}

function renderNextUp() {
  const el = $('#next-up');
  const n = S.show.calendar ? nextUp() : null;
  if (!n) {
    el.hidden = true;
    return;
  }
  const { event: e, mode } = n;
  const time = new Date(e.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !S.clock24 });
  const until = new Date(e.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !S.clock24 });
  const mins = Math.round((e.start - Date.now()) / 60000);
  const when = mode === 'now' ? `until ${until}` : mins < 60 ? `in ${Math.max(1, mins)} min` : `at ${time}`;
  const trip = mode === 'next' ? tripInfo(e)?.leave : null;
  const leave = trip && trip.at - Date.now() < 90 * 60e3 ? leaveText(trip, (ms) => fmtTime(ms, S.clock24)) : null;
  el.hidden = false;
  el.classList.toggle('soon', Boolean(mode === 'now' || mins <= 15 || leave?.level));
  // The bubble wears the event's calendar color; Now or Next is in its tooltip.
  el.style.setProperty('--c', colorVar(e.color));
  el.title = `${mode === 'now' ? 'Now' : 'Next'}: ${e.title}`;
  el.innerHTML = `<span class="nu-title">${esc(e.title)}</span>
    <span class="nu-when">${when}</span>
    ${leave ? `<span class="nu-leave${leave.level ? ` ${leave.level}` : ''}" title="About ${trip.mins} min drive">${icon('car')}${esc(leave.text)}</span>` : ''}
    ${e.join ? `<a class="join" href="${esc(safeUrl(e.join))}">${icon('video')}<span>Join</span></a>` : ''}`;
}

// ---- The bubble in the search box ------------------------------------------------------
// What's next, the coming holiday and a followed team's win share a bubble at the end of the
// search box, flipping over to the next every few seconds. It holds still under the pointer, and
// stays on what's next when that's soon. Each one shows or hides itself (renderNextUp,
// renderHoliday, and teams.js for wins).

const FLIP_EVERY = 6000;

function initFlip() {
  const box = $('#flip');
  let held = false;
  const faces = () => [...box.children].filter((f) => !f.hidden);
  const show = (face) => {
    for (const f of box.children) {
      if (f === face) f.classList.add('shown');
      else if (f.classList.contains('shown')) {
        f.classList.replace('shown', 'gone');
        setTimeout(() => f.classList.remove('gone'), 700);
      }
    }
  };
  // After either changes: hide the bubble with nothing to show, and keep one face up.
  const settle = () => {
    const list = faces();
    // Set only on a change: setting it at all is a mutation, which would call this again.
    if (box.hidden !== !list.length) box.hidden = !list.length;
    for (const f of box.children) if (f.hidden) f.classList.remove('shown', 'gone');
    const soon = list.find((f) => f.classList.contains('soon'));
    if (soon && !soon.classList.contains('shown')) show(soon);
    else if (list.length && !list.some((f) => f.classList.contains('shown'))) show(list[0]);
  };
  new MutationObserver(settle).observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  const hold = (on) => () => (held = on || box.matches(':hover, :focus-within'));
  box.addEventListener('pointerenter', hold(true));
  box.addEventListener('pointerleave', hold(false));
  box.addEventListener('focusin', hold(true));
  box.addEventListener('focusout', () => setTimeout(hold(false)));
  setInterval(() => {
    const list = faces();
    const at = list.findIndex((f) => f.classList.contains('shown'));
    if (held || document.hidden || list.length < 2 || list[at]?.classList.contains('soon')) return;
    show(list[(at + 1) % list.length]);
  }, FLIP_EVERY);
  settle();
}

let lastMinute = -1;
function tick(force = false) {
  const d = new Date();
  const minute = d.getHours() * 60 + d.getMinutes();
  if (minute === lastMinute && !force) return;
  lastMinute = minute;
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: !S.clock24 }).formatToParts(d);
  $('#clock-time').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  $('#clock-ampm').textContent = parts.find((p) => p.type === 'dayPeriod')?.value || '';
  const h = d.getHours();
  const hello = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = S.name ? `${hello}, ${S.name}` : hello;
  $('#date-long').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const dayOfYear = Math.round((d.setHours(0, 0, 0, 0) - new Date(d.getFullYear(), 0, 0)) / 86400000);
  $('#date-meta').textContent = `Week ${isoWeek(new Date())} · Day ${dayOfYear}`;
  document.documentElement.dataset.phase = skyPhase();
  renderSun();
  if (S.show.sky) {
    renderMoon(lastWeather()?.lat ?? homeLat);
    renderHoliday();
  }
  renderNextUp();
  if (S.show.calendar) {
    renderAgenda(S);
    renderMonth();
  }
  if (S.show.mail) renderMail();
}

// ---- Search ------------------------------------------------------------------------

// The circle at the start of the search box says who gets what you type: Claude, ChatGPT or
// Gemini, or the search engine (Google unless Settings picks another). Clicking it turns to the
// next, and the pick is kept as the default search.
const AIS = ['claude', 'chatgpt', 'gemini'];

function initSearch() {
  let engine = ENGINES[S.searchEngine] ? S.searchEngine : 'google';
  // The search engine the circle comes back around to.
  let base = ENGINES[engine].ask ? 'google' : engine;
  const input = $('#search-input');
  const chips = $('#engines');
  const pick = $('#ai-pick');
  const nextOf = (k) => {
    const turn = [...AIS, base];
    return turn[(turn.indexOf(k) + 1) % turn.length];
  };
  const paint = () => {
    const what = (k) => `${ENGINES[k].ask ? 'Ask' : 'Search'} ${ENGINES[k].label}`;
    input.placeholder = what(engine);
    pick.innerHTML = ENGINES[engine].ask ? aiMark(engine) : icon('search');
    pick.dataset.engine = engine;
    pick.title = `${what(engine)}. Click to switch to ${ENGINES[nextOf(engine)].label}.`;
    pick.setAttribute('aria-label', pick.title);
    chips.innerHTML = Object.entries(ENGINES)
      .map(
        ([k, e]) =>
          `<button type="button" role="radio" aria-checked="${k === engine}" class="engine${k === engine ? ' on' : ''}" data-engine="${k}" title="Type !${e.bang} before your search to use ${e.label}">${e.label}</button>`,
      )
      .join('');
  };
  paint();
  const use = (k) => {
    engine = k;
    if (!ENGINES[k].ask) base = k;
    paint();
    input.focus();
    updatePlaces();
  };
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-engine]');
    if (b) use(b.dataset.engine);
  });
  pick.addEventListener('click', () => {
    use(nextOf(engine));
    S.searchEngine = engine;
    saveSettings(S);
  });
  // A click anywhere else in the box goes to the text.
  $('.search-box').addEventListener('click', (e) => {
    if (!e.target.closest('button, a, input')) input.focus();
  });
  const navigate = (url, newTab) => (newTab ? window.open(url, '_blank') : (location.href = url));
  initPlaces({ input, isActive: () => engine === 'maps' || /^!m\s/i.test(input.value), navigate });
  initAsk(input);
  const go = (newTab) => {
    if (openActivePlace(newTab)) return;
    let q = input.value.trim();
    if (!q) return;
    let use = engine;
    const bang = q.match(/^!(\w+)\s+(.+)$/);
    if (bang) {
      const found = Object.entries(ENGINES).find(([, e]) => e.bang === bang[1].toLowerCase());
      if (found) {
        use = found[0];
        q = bang[2];
      }
    }
    const looksLikeUrl = !/\s/.test(q) && /^(https?:\/\/)?(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(q) && !bang;
    // Claude, ChatGPT and Gemini answer on the page when there's an API key; otherwise (or
    // with Ctrl/Cmd+Enter) the question opens on their site, where you're signed in.
    if (ENGINES[use].ask && !looksLikeUrl && !newTab && hasKey(use)) {
      ask(use, q);
      input.value = '';
      return;
    }
    const url = looksLikeUrl ? (/^https?:\/\//i.test(q) ? q : `https://${q}`) : ENGINES[use].url.replace('%s', encodeURIComponent(q));
    navigate(url, newTab);
  };
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    go(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      go(true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]') && !$('#settings').open) {
      e.preventDefault();
      input.focus();
    }
  });
}

// ---- Shortcuts ---------------------------------------------------------------------

const favicon = (url) => `/_favicon/?${new URLSearchParams({ pageUrl: url, size: '32' })}`;

function siteName(title, host) {
  const t = (title || '').split(/\s*[-–—|·:]\s/)[0].trim();
  if (t && t.length <= 14) return t;
  const base = host.split('.').slice(-2, -1)[0] || host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function initShortcuts() {
  if (!S.show.shortcuts) return;
  const pinned = [
    { title: 'Gmail', url: 'https://mail.google.com/mail/u/0/' },
    { title: 'Calendar', url: 'https://calendar.google.com/' },
    { title: 'Outlook', url: outlookWebUrl(await msAccount()) },
  ];
  let top = [];
  try {
    top = await chrome.topSites.get();
  } catch {}
  const seen = new Set();
  const list = [];
  for (const s of [...pinned, ...top]) {
    let host;
    try {
      host = new URL(s.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    list.push({ title: siteName(s.title, host), url: s.url });
    if (list.length >= 10) break;
  }
  setTicker('shortcuts', list.map((s) => ({ title: s.title, href: s.url })));
  const sites = list
    .map((s) => `<a class="shortcut" href="${esc(s.url)}" title="${esc(s.url)}"><img src="${favicon(s.url)}" alt="" width="20" height="20"><span>${esc(s.title)}</span></a>`)
    .join('');
  // Groups of saved sites come first, so they never fall off the end of the row.
  const paint = async () => ($('#shortcuts').innerHTML = (await groupTiles({ companies: S.show.companies, changed: paint })) + sites);
  await paint();
}

// ---- Notes -------------------------------------------------------------------------

async function initNotes() {
  if (!S.show.notes) return;
  const ta = $('#notes');
  const { notes = '' } = await chrome.storage.sync.get('notes');
  ta.value = notes;
  const lines = () => ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((title) => ({ tag: 'Note', title: title.slice(0, 160) }));
  setTicker('notes', lines());
  let timer;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    $('#notes-state').textContent = '';
    timer = setTimeout(async () => {
      await chrome.storage.sync.set({ notes: ta.value });
      $('#notes-state').textContent = 'saved';
      setTicker('notes', lines());
    }, 500);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.notes || document.activeElement === ta) return;
    ta.value = changes.notes.newValue || '';
    setTicker('notes', lines());
  });
}

// ---- Updates -----------------------------------------------------------------------
// Chrome serves an unpacked extension's pages straight from its folder, so new tabs pick up
// updated files on their own. A new manifest or background worker needs Chrome to restart
// the extension, which is what the button does.

async function checkForUpdate() {
  try {
    const onDisk = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then((r) => r.json());
    if (!onDisk.version || onDisk.version === chrome.runtime.getManifest().version) return;
    const bar = $('#update-bar');
    bar.innerHTML = `<span>Daybook ${esc(onDisk.version)} is downloaded.</span><button class="btn small primary" type="button" id="update-go">Finish update</button>`;
    bar.hidden = false;
    $('#update-go').addEventListener('click', () => chrome.runtime.reload());
  } catch {}
}

// ---- Refresh loop ------------------------------------------------------------------

function renderCalendars() {
  renderAgenda(S);
  renderMonth();
  renderNextUp();
}

// Weather and leave-by times for events with a place, once the calendars settle.
let tripTimer;
function scheduleTrips() {
  if (!S.show.calendar || !S.show.travel) return;
  clearTimeout(tripTimer);
  tripTimer = setTimeout(() => planTrips(S, allEvents(), renderCalendars), 800);
}

function refreshAll(force = false) {
  if (S.show.weather)
    refreshWeather(S, force, (data) => {
      document.documentElement.dataset.phase = skyPhase();
      if (S.show.sky) renderMoon(data.lat);
      if (S.show.alerts) refreshAlerts(S, data, force);
      scheduleTrips();
    });
  if (S.show.mail) refreshMail(S, force);
  if (S.show.calendar)
    refreshCalendars(S, force, () => {
      renderCalendars();
      scheduleTrips();
    });
  if (S.show.stocks) refreshStocks(S, force);
  if (S.show.teams)
    refreshTeams(S, force, (games) => {
      setGames(games);
      if (S.show.calendar) renderCalendars();
    });
  if (S.show.area) refreshArea(S, force);
  if (S.show.jobs) refreshJobs(S, force);
  if (newsCard) refreshNews(S, force);
  if (newsTicker) refreshTicker(S, force);
  if (S.show.youtube) refreshYouTube(S, force);
}

document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open-settings]');
  if (opener) openSettings(S, opener.dataset.openSettings);
});
$('#settings-btn').addEventListener('click', () => openSettings(S));
$('#refresh-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spin');
  setTimeout(() => btn.classList.remove('spin'), 900);
  refreshAll(true);
});

// Where the data comes from, once, in soft text under the board.
const credits = {
  weather: S.show.weather && 'Weather by <a href="https://open-meteo.com/">Open-Meteo.com</a>',
  alerts: S.show.alerts && 'alerts by the <a href="https://www.weather.gov/">National Weather Service</a>',
  news: S.show.news && 'headlines by <a href="https://news.google.com/">Google News</a>',
  stocks: S.show.stocks && S.stocks.key && 'quotes by <a href="https://finnhub.io/">Finnhub</a>',
  teams: S.show.teams && S.teams.list.length && 'schedules by <a href="https://www.espn.com/">ESPN</a>',
  area: S.show.area && S.area.key && 'events by <a href="https://www.ticketmaster.com/">Ticketmaster</a>',
  jobs: S.show.jobs && 'vacancies from <a href="https://statejobs.ny.gov/">StateJobsNY</a>',
};
for (const [key, html] of Object.entries(credits)) setCredit(key, html || '');

initSearch();
initFlip();
initLayout();
// Deliveries come from shipping emails, from the packages added by hand in Settings, or both.
if (S.show.packages && (S.show.mail || S.packages.tracked.length)) initDeliveries(S);
else $('#card-deliveries').hidden = true;
initMail();
initAlerts();
initWeather();
if (S.show.calendar) {
  initMonth(S);
  initEvents(S, {
    onChange: () => {
      renderCalendars();
      refreshCalendars(S, true, () => {
        renderCalendars();
        scheduleTrips();
      });
    },
  });
  initDetails(S);
}
setHolidayChoices(S.holidays.choices);
setSkyOnPage(skyOnPage);
if (S.show.sky) loadHolidays(() => {
  renderHoliday();
  if (S.show.calendar) renderMonth();
});
$('#moon').hidden = !skyOnPage;
if (S.show.youtube) await initYouTube(S);
initNews();
initTicker(S);
if (S.show.area) initArea();
tick(true);
setInterval(tick, 1000);
initShortcuts();
initNotes();
refreshAll();
// Other pages link to a part of Settings as newtab.html#settings-<section>.
const settingsLink = location.hash.match(/^#settings-(\w+)$/)?.[1];
if (settingsLink) history.replaceState(null, '', location.pathname);
if (!S.onboarded) openWelcome(S);
else if (settingsLink) openSettings(S, settingsLink);
checkForUpdate();
setInterval(() => document.visibilityState === 'visible' && refreshAll(), 60e3);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshAll());
