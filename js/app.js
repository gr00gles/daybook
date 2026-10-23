import { loadSettings, ENGINES, outlookWebUrl } from './settings.js';
import { $, $$, esc, colorVar, safeUrl, fmtTime, local } from './util.js';
import { refreshWeather, renderSun, lastWeather, todayIndex, initWeather } from './weather.js';
import { refreshMail, initMail, renderMail } from './mail.js';
import { refreshCalendars, renderAgenda, nextUp, allEvents, setGames } from './calendar.js';
import { initAlerts, refreshAlerts } from './alerts.js';
import { renderMoon, loadHolidays, renderHoliday, setHolidayChoices } from './sky.js';
import { planTrips, tripInfo, leaveText } from './trip.js';
import { refreshStocks } from './stocks.js';
import { refreshTeams } from './teams.js';
import { initArea, refreshArea } from './area.js';
import { initJobs, refreshJobs } from './jobs.js';
import { initEvents } from './events.js';
import { initDetails } from './details.js';
import { initMonth, renderMonth } from './month.js';
import { initPlaces, updatePlaces, openActivePlace } from './places.js';
import { initYouTube, refreshYouTube } from './youtube.js';
import { refreshNews, initNews } from './news.js';
import { openSettings } from './sheet.js';
import { openWelcome } from './onboarding.js';
import { msAccount } from './msauth.js';
import { icon } from './icons.js';
import { groupTiles } from './sites.js';
import { initDeliveries } from './packages.js';
import { initAsk, ask, hasKey } from './ask.js';
import { applyLayout, initLayout } from './layout.js';

const S = await loadSettings();
await applyLayout();

if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
for (const [section, on] of Object.entries(S.show)) {
  for (const el of $$(`[data-section="${section}"]`)) el.toggleAttribute('hidden', !on);
}
// The moon sits under the current weather but has its own switch. Without the weather, the
// hemisphere (which way the moon is lit) comes from the city in Settings or the last location fix.
if (S.show.sky && !S.show.weather) $('.now-weather').hidden = false;
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
  el.className = `next-up${mode === 'now' || mins <= 15 || leave?.level ? ' soon' : ''}`;
  el.innerHTML = `<span class="nu-label">${mode === 'now' ? 'Now' : 'Next'}</span>
    <span class="cal-dot" style="--c: ${colorVar(e.color)}"></span>
    <span class="nu-title">${esc(e.title)}</span>
    <span class="nu-when">${when}</span>
    ${leave ? `<span class="nu-leave${leave.level ? ` ${leave.level}` : ''}" title="About ${trip.mins} min drive">${icon('car')}${esc(leave.text)}</span>` : ''}
    ${e.join ? `<a class="join" href="${esc(safeUrl(e.join))}">${icon('video')}<span>Join</span></a>` : ''}`;
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

function initSearch() {
  let engine = ENGINES[S.searchEngine] ? S.searchEngine : 'google';
  const input = $('#search-input');
  const chips = $('#engines');
  const paint = () => {
    input.placeholder = `${ENGINES[engine].ask ? 'Ask' : 'Search'} ${ENGINES[engine].label}`;
    chips.innerHTML = Object.entries(ENGINES)
      .map(
        ([k, e]) =>
          `<button type="button" role="radio" aria-checked="${k === engine}" class="engine${k === engine ? ' on' : ''}" data-engine="${k}" title="Type !${e.bang} before your search to use ${e.label}">${e.label}</button>`,
      )
      .join('');
  };
  paint();
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-engine]');
    if (!b) return;
    engine = b.dataset.engine;
    paint();
    input.focus();
    updatePlaces();
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
    // Claude and ChatGPT answer on the page when there's an API key; otherwise (or with
    // Ctrl/Cmd+Enter) the question opens on their site, where you're signed in.
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
  let timer;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    $('#notes-state').textContent = '';
    timer = setTimeout(async () => {
      await chrome.storage.sync.set({ notes: ta.value });
      $('#notes-state').textContent = 'saved';
    }, 500);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.notes && document.activeElement !== ta) ta.value = changes.notes.newValue || '';
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
  if (S.show.news) refreshNews(S, force);
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

initSearch();
initLayout();
if (S.show.mail && S.show.packages) initDeliveries();
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
if (S.show.sky) loadHolidays(() => {
  renderHoliday();
  if (S.show.calendar) renderMonth();
});
$('#moon').hidden = !S.show.sky;
if (S.show.youtube) await initYouTube(S);
initNews();
if (S.show.area) initArea();
if (S.show.jobs) initJobs();
tick(true);
setInterval(tick, 1000);
initShortcuts();
initNotes();
refreshAll();
if (!S.onboarded) openWelcome(S);
checkForUpdate();
setInterval(() => document.visibilityState === 'visible' && refreshAll(), 60e3);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshAll());
