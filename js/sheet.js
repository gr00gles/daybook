// The Settings sheet. Every change saves as you make it; closing the sheet reloads the page
// so each card picks up the new settings.
import { $, $$, esc } from './util.js';
import { saveSettings, NEWS_TOPICS, ENGINES } from './settings.js';
import { extraOrigins } from './calendar.js';
import { mountGoogle, mountGmail, mountOutlook, mountLocation } from './setup-ui.js';
import { icon } from './icons.js';
import { AREA_KINDS } from './area.js';

let draft;
let dirty = false;
let saveTimer;

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];
const COLOR_NAMES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Magenta', 'Green', 'Violet', 'Red'];

const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
const check = (path, label, on) =>
  `<label class="check"><input type="checkbox" data-path="${path}"${on ? ' checked' : ''}><span>${label}</span></label>`;

function colorSelect(attrs, current) {
  return `<span class="swatch-wrap"><span class="cal-dot" style="--c: var(--cat-${current})"></span><select class="swatch" ${attrs} aria-label="Color">${COLORS.map((c) => opt(c, COLOR_NAMES[c - 1], current)).join('')}</select></span>`;
}

function build() {
  const d = draft;
  return `<form method="dialog" class="sheet-inner" id="settings-form" novalidate>
  <header class="sheet-head">
    <h2>Settings</h2>
    <button class="icon-btn" type="submit" value="done" aria-label="Close settings">${icon('close')}</button>
  </header>

  <section id="set-accounts">
    <h3>Accounts</h3>
    <div class="acct">
      <h4>Google Calendar</h4>
      <div id="sheet-google"></div>
    </div>
    <div class="acct">
      <h4>Gmail</h4>
      <div id="sheet-gmail"></div>
    </div>
    <div class="acct">
      <h4>Outlook</h4>
      <div id="sheet-outlook"></div>
      <div class="row wrap"><span class="swatch-label">Outlook calendar color ${colorSelect('id="s-ms-color" data-path="outlook.color" data-type="number"', d.outlook.color)}</span></div>
    </div>
    <button class="btn small" type="button" data-action="rerun">${icon('refresh')}Run first-time setup again</button>
  </section>

  <section id="set-you">
    <h3>You</h3>
    <div class="grid2">
      <label class="field"><span>Name for the greeting</span><input id="s-name" type="text" data-path="name" value="${esc(d.name)}" autocomplete="off"></label>
      <label class="field"><span>Theme</span><select id="s-theme" data-path="theme">${opt('system', 'Match my computer', d.theme)}${opt('light', 'Light', d.theme)}${opt('dark', 'Dark', d.theme)}</select></label>
      <label class="field"><span>Clock</span><select id="s-clock" data-path="clock24" data-type="bool">${opt(false, '12-hour (3:30 PM)', d.clock24)}${opt(true, '24-hour (15:30)', d.clock24)}</select></label>
      <label class="field"><span>Temperature</span><select id="s-units" data-path="units">${opt('F', 'Fahrenheit (°F)', d.units)}${opt('C', 'Celsius (°C)', d.units)}</select></label>
      <label class="field"><span>Default search</span><select id="s-engine" data-path="searchEngine">${Object.entries(ENGINES).map(([k, e]) => opt(k, e.label, d.searchEngine)).join('')}</select></label>
    </div>
  </section>

  <section id="set-location">
    <h3>Weather location</h3>
    <div id="sheet-location"></div>
  </section>

  <section id="set-calendars">
    <h3>Other calendars</h3>
    <p class="hint">Add any calendar that has an iCal (.ics) link: an Outlook calendar published from Outlook.com (Settings → Calendar → Shared calendars → <em>Publish a calendar</em>), an iCloud calendar shared publicly, a sports schedule or a school calendar. Treat private links like passwords.</p>
    ${d.calendars
      .map(
        (c, i) => `<div class="cal-row">
        <div class="row">
          ${colorSelect(`id="s-cal-${i}-color" data-list="calendars" data-i="${i}" data-field="color" data-type="number"`, c.color)}
          <label class="field"><span>Name</span><input id="s-cal-${i}-name" type="text" data-list="calendars" data-i="${i}" data-field="name" value="${esc(c.name)}"></label>
          <label class="check small"><input id="s-cal-${i}-on" type="checkbox" data-list="calendars" data-i="${i}" data-field="enabled"${c.enabled ? ' checked' : ''}><span>Show</span></label>
          <button class="icon-btn" type="button" data-action="remove" data-list="calendars" data-i="${i}" aria-label="Remove ${esc(c.name)}">${icon('close')}</button>
        </div>
        <label class="field"><span>iCal link (.ics)</span><input id="s-cal-${i}-url" type="url" data-list="calendars" data-i="${i}" data-field="url" value="${esc(c.url)}" placeholder="https://…/calendar.ics" spellcheck="false"></label>
      </div>`,
      )
      .join('')}
    <button class="btn small" type="button" data-action="add-calendar">${icon('plus')}Add a calendar link</button>
  </section>

  <section id="set-news">
    <h3>Headlines</h3>
    <div class="topics">${Object.entries(NEWS_TOPICS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-topic="${k}"${d.news.topics.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
    ${d.news.custom
      .map(
        (f, i) => `<div class="row">
        <label class="field narrow"><span>Label</span><input id="s-feed-${i}-label" type="text" data-list="news.custom" data-i="${i}" data-field="label" value="${esc(f.label)}"></label>
        <label class="field"><span>RSS or Atom feed</span><input id="s-feed-${i}-url" type="url" data-list="news.custom" data-i="${i}" data-field="url" value="${esc(f.url)}" spellcheck="false"></label>
        <button class="icon-btn" type="button" data-action="remove" data-list="news.custom" data-i="${i}" aria-label="Remove feed">${icon('close')}</button>
      </div>`,
      )
      .join('')}
    <button class="btn small" type="button" data-action="add-feed">${icon('plus')}Add a feed</button>
  </section>

  <section id="set-youtube">
    <h3>YouTube</h3>
    <p class="hint">New uploads from the channels you subscribe to, from the last week.</p>
    ${check('youtube.hideShorts', 'Hide Shorts', d.youtube.hideShorts)}
  </section>

  <section id="set-travel">
    <h3>Travel time</h3>
    <p class="hint">For events with an address, Daybook shows the weather there and, for the next 24 hours, when to leave from where you are. Addresses are looked up with Photon (OpenStreetMap), and drive times come from OSRM, which doesn’t know about traffic.</p>
    <div class="grid2">
      <label class="field"><span>Extra time before leaving</span><select id="s-buffer" data-path="travel.buffer" data-type="number">${[0, 5, 10, 15, 20, 30].map((m) => opt(m, m ? `${m} minutes` : 'None', d.travel.buffer)).join('')}</select></label>
      <label class="field"><span>TomTom key for live traffic (optional)</span><input id="s-tomtom" type="text" data-path="travel.tomtomKey" value="${esc(d.travel.tomtomKey)}" placeholder="Paste your TomTom API key" spellcheck="false" autocomplete="off"></label>
    </div>
    <p class="hint">To get a TomTom key, sign up free at <a href="https://developer.tomtom.com/" target="_blank" rel="noopener">developer.tomtom.com</a> and copy the key from your dashboard.</p>
  </section>

  <section id="set-stocks">
    <h3>Stocks</h3>
    <p class="hint">A watchlist card under the weather. It needs a free key from Finnhub: sign up at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a> and copy the API key from your dashboard.</p>
    <div class="grid2">
      <label class="field"><span>Finnhub API key</span><input id="s-finnhub" type="text" data-path="stocks.key" value="${esc(d.stocks.key)}" placeholder="Paste your Finnhub API key" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Symbols, separated by commas</span><input id="s-symbols" type="text" data-path="stocks.symbols" data-type="list" value="${esc(d.stocks.symbols.join(', '))}" placeholder="SPY, AAPL, MSFT" spellcheck="false" autocomplete="off"></label>
    </div>
  </section>

  <section id="set-area">
    <h3>Area events</h3>
    <p class="hint">Concerts, shows, festivals and games around your weather location, from Ticketmaster. It needs a free key: sign up at <a href="https://developer-acct.ticketmaster.com/user/register" target="_blank" rel="noopener">developer.ticketmaster.com</a>, open <strong>My Apps</strong> and copy the <strong>Consumer Key</strong>. Brewery nights and other small local events are rarely on Ticketmaster, so the card also has quick searches for those.</p>
    <label class="field"><span>Ticketmaster key</span><input id="s-ticketmaster" type="text" data-path="area.key" value="${esc(d.area.key)}" placeholder="Paste your Ticketmaster Consumer Key" spellcheck="false" autocomplete="off"></label>
    <div class="grid2">
      <label class="field"><span>How far</span><select id="s-area-radius" data-path="area.radius" data-type="number">${[10, 25, 50, 100].map((r) => opt(r, `Within ${r} ${d.units === 'C' ? 'km' : 'miles'}`, d.area.radius)).join('')}</select></label>
      <label class="field"><span>How far ahead</span><select id="s-area-days" data-path="area.days" data-type="number">${[[7, 'The next week'], [14, 'The next two weeks'], [30, 'The next month']].map(([n, l]) => opt(n, l, d.area.days)).join('')}</select></label>
    </div>
    <div class="topics">${Object.entries(AREA_KINDS)
      .map(([k, t]) => `<label class="check"><input type="checkbox" data-area-kind="${k}"${d.area.kinds.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
      .join('')}</div>
  </section>

  <section id="set-sections">
    <h3>Sections</h3>
    <div class="topics">
      ${check('show.weather', 'Weather', d.show.weather)}
      ${check('show.alerts', 'Weather alerts', d.show.alerts)}
      ${check('show.sky', 'Moon and holidays', d.show.sky)}
      ${check('show.calendar', 'Calendar', d.show.calendar)}
      ${check('show.travel', 'Travel time and event weather', d.show.travel)}
      ${check('show.mail', 'Mail', d.show.mail)}
      ${check('show.packages', 'Deliveries', d.show.packages)}
      ${check('show.news', 'Headlines', d.show.news)}
      ${check('show.stocks', 'Stocks', d.show.stocks)}
      ${check('show.area', 'Area events', d.show.area)}
      ${check('show.notes', 'Notes', d.show.notes)}
      ${check('show.youtube', 'YouTube', d.show.youtube)}
      ${check('show.shortcuts', 'Shortcuts', d.show.shortcuts)}
    </div>
  </section>

  <section id="set-advanced">
    <details>
      <summary>Advanced</summary>
      <label class="field"><span>Microsoft app (client) ID</span><input id="s-ms-client" type="text" data-path="outlook.clientId" value="${esc(d.outlook.clientId)}" placeholder="Leave empty to use the one built into this copy" spellcheck="false" autocomplete="off"></label>
      <p class="hint">Only needed if you registered your own Microsoft app. Redirect URI: <code>${esc(chrome.identity?.getRedirectURL?.() || '')}</code></p>
    </details>
  </section>

  <footer class="sheet-foot">
    <span class="hint" id="save-state">Changes save as you go.</span>
    <button class="btn primary" type="submit" value="done">Done</button>
  </footer>
</form>`;
}

const listAt = (path) => path.split('.').reduce((o, k) => o[k], draft);

function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], draft)[last] = value;
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') return Number(el.value);
  if (el.dataset.type === 'bool') return el.value === 'true';
  if (el.dataset.type === 'list') return [...new Set(el.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return el.value;
}

function queueSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(draft);
    const s = $('#save-state');
    if (s) s.textContent = 'Saved.';
  }, 250);
}

function mountAll() {
  mountGoogle($('#sheet-google'), draft, queueSave);
  mountGmail($('#sheet-gmail'), draft, queueSave);
  mountOutlook($('#sheet-outlook'), draft, queueSave);
  mountLocation($('#sheet-location'), draft, queueSave);
}

function rerender() {
  const dlg = $('#settings');
  const scroll = dlg.scrollTop;
  dlg.innerHTML = build();
  mountAll();
  dlg.scrollTop = scroll;
}

let wired = false;

function wire(dlg) {
  if (wired) return;
  wired = true;
  const onEdit = (e) => {
    const el = e.target;
    if (el.closest('#sheet-google, #sheet-gmail, #sheet-outlook, #sheet-location')) return;
    if (el.dataset.path) {
      setPath(el.dataset.path, readValue(el));
    } else if (el.dataset.list) {
      listAt(el.dataset.list)[Number(el.dataset.i)][el.dataset.field] = readValue(el);
    } else if (el.dataset.topic) {
      const set = new Set(draft.news.topics);
      if (el.checked) set.add(el.dataset.topic);
      else set.delete(el.dataset.topic);
      draft.news.topics = Object.keys(NEWS_TOPICS).filter((k) => set.has(k));
    } else if (el.dataset.areaKind) {
      const set = new Set(draft.area.kinds);
      if (el.checked) set.add(el.dataset.areaKind);
      else set.delete(el.dataset.areaKind);
      draft.area.kinds = Object.keys(AREA_KINDS).filter((k) => set.has(k));
    } else return;
    if (el.classList.contains('swatch')) el.previousElementSibling.style.setProperty('--c', `var(--cat-${el.value})`);
    queueSave();
  };
  dlg.addEventListener('input', onEdit);
  dlg.addEventListener('change', onEdit);

  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) {
      dlg.requestClose ? dlg.requestClose() : dlg.close();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'remove') {
      listAt(btn.dataset.list).splice(Number(btn.dataset.i), 1);
      queueSave();
      rerender();
    } else if (action === 'add-calendar') {
      const used = new Set(draft.calendars.map((c) => c.color));
      draft.calendars.push({ id: `c${Date.now().toString(36)}`, name: 'New calendar', color: COLORS.find((c) => !used.has(c)) ?? 1, url: '', enabled: true });
      queueSave();
      rerender();
      $(`#s-cal-${draft.calendars.length - 1}-url`)?.focus();
    } else if (action === 'add-feed') {
      draft.news.custom.push({ label: '', url: '' });
      queueSave();
      rerender();
    } else if (action === 'rerun') {
      draft.onboarded = false;
      queueSave();
      dlg.close();
    }
  });

  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Calendar and feed links on other hosts need Chrome's OK; this click counts as the gesture.
    const origins = [...new Set(extraOrigins([...draft.calendars.map((c) => c.url), ...draft.news.custom.map((f) => f.url)].filter(Boolean)))];
    if (origins.length) {
      try {
        const has = await chrome.permissions.contains({ origins });
        if (!has) await chrome.permissions.request({ origins });
      } catch {}
    }
    dlg.close();
  });

  dlg.addEventListener('close', async () => {
    clearTimeout(saveTimer);
    if (!dirty) return;
    await saveSettings(draft);
    location.reload();
  });
}

export function openSettings(S, section) {
  const dlg = $('#settings');
  draft = structuredClone(S);
  dirty = false;
  wire(dlg);
  dlg.innerHTML = build();
  mountAll();
  dlg.showModal();
  const target = section && $(`#set-${section}`);
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.add('flash');
    $$('input, select, button', target)[0]?.focus({ preventScroll: true });
  }
}
