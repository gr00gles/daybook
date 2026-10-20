// The month calendar: every day of the month with its events, flippable to other months.
// Clicking a day shows that day's full schedule under the grid.
import { $, esc, colorVar, startOfDay, addDays, safeUrl } from './util.js';
import { monthGrid, eventsBetween, ensureMonth, FIRST_DAY, timedRow, allDayChips } from './calendar.js';
import { icon } from './icons.js';
import { holidaysOn, loadHolidays, coveredBy } from './sky.js';
import { openEventEditor } from './events.js';

const SHOWN_PER_DAY = 3;
const MAX_LANES = 3; // rows of multi-day bars per week
let settingsRef;
let view;
let selected = null;
let firstClick = null; // the day the first click of a possible double-click was on

const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

// Holidays the calendars don't already show that day.
const holidays = (d0, list) =>
  settingsRef.show.sky ? holidaysOn(d0).filter((h) => !coveredBy(h, list.filter((e) => e.allDay).map((e) => e.title))) : [];

// Events that cover more than one day (all-day ones, or timed ones a calendar day or longer)
// are drawn as bars across the days; the rest sit inside their day.
const lastDay = (e) => startOfDay(e.end - 1);
const spansDays = (e) => lastDay(e) > startOfDay(e.start) && (e.allDay || e.end >= addDays(e.start, 1));

function dayEvents(events, d0) {
  const d1 = addDays(d0, 1);
  // All-day events and anything drawn as a bar belong to every day they cover; other timed
  // events sit on the day they start.
  return events.filter((e) => (e.allDay || spansDays(e) ? e.start < d1 && e.end > d0 : e.start >= d0 && e.start < d1));
}

// Lays a week's multi-day events out in rows: each gets the first row free on all its days.
function weekBars(events, weekStart) {
  const weekEnd = addDays(weekStart, 7);
  const col = (t) => Math.round((startOfDay(t) - weekStart) / 86400e3);
  const rows = [];
  const bars = [];
  const hidden = new Array(7).fill(0);
  const list = events
    .filter((e) => spansDays(e) && e.start < weekEnd && lastDay(e) >= weekStart)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  for (const e of list) {
    const c0 = Math.max(0, col(e.start));
    const c1 = Math.min(6, col(lastDay(e)));
    let lane = rows.findIndex((used) => used.slice(c0, c1 + 1).every((x) => !x));
    if (lane < 0 && rows.length < MAX_LANES) lane = rows.push(new Array(7).fill(false)) - 1;
    if (lane < 0) {
      for (let c = c0; c <= c1; c++) hidden[c]++;
      continue;
    }
    for (let c = c0; c <= c1; c++) rows[lane][c] = true;
    bars.push({ e, c0, span: c1 - c0 + 1, lane, before: startOfDay(e.start) < weekStart, after: lastDay(e) >= weekEnd });
  }
  return { bars, lanes: rows.length, hidden, rows };
}

function weekdayLabels() {
  // 1 January 2023 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2023, 0, 1 + ((FIRST_DAY + i) % 7));
    return `<span class="mwd" aria-hidden="true">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>`;
  }).join('');
}

function cell(d0, events, now, week, c) {
  const d = new Date(d0);
  const outside = d.getMonth() !== view.m;
  const today = sameDay(d0, now);
  const past = d0 < startOfDay(now);
  const list = dayEvents(events, d0);
  const hols = holidays(d0, list);
  // Bars over this day take some of its room; the rest go to its own events.
  const singles = list.filter((e) => !spansDays(e));
  const room = Math.max(1, SHOWN_PER_DAY - week.lanes);
  const shown = singles.slice(0, room);
  const more = singles.length - shown.length + week.hidden[c];
  const label = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${hols.map((h) => `, ${h.name}`).join('')}: ${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : 'nothing scheduled'}`;
  const cls = ['mday', outside && 'out', today && 'today', past && 'past', selected === d0 && 'sel', hols.some((h) => !h.clock) && 'hol'].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" data-day="${d0}" aria-label="${esc(label)}"${selected === d0 ? ' aria-pressed="true"' : ''}${hols.length ? ` title="${esc(hols.map((h) => h.name).join(', '))}"` : ''}>
    <span class="mnum">${d.getDate()}</span>
    ${week.lanes ? '<span class="mlanes" aria-hidden="true"></span>' : ''}
    ${hols.map((h) => `<span class="mhol${h.clock ? ' clock' : ''}">${esc(h.name)}</span>`).join('')}
    <span class="mevs">${shown
      .map((e) => `<span class="mev${e.allDay ? ' all' : ''}${e.logo ? ' logo' : ''}" style="--c: ${colorVar(e.color)}">${e.logo ? `<img src="${esc(safeUrl(e.logo))}" alt="" width="12" height="12" loading="lazy">` : ''}${esc(e.title)}</span>`)
      .join('')}${more > 0 ? `<span class="mmore">+${more}</span>` : ''}</span>
  </button>`;
}

function bar({ e, c0, span, lane, before, after }) {
  const cls = ['mbar', !e.allDay && 'timed', before && 'cont-l', after && 'cont-r'].filter(Boolean).join(' ');
  return `<span class="${cls}" style="--c: ${colorVar(e.color)}; --col: ${c0}; --span: ${span}; --lane: ${lane}" aria-hidden="true">${esc(e.title)}</span>`;
}

function detail(events, now) {
  if (selected === null) return '<p class="mhint">Click a day to see its schedule.</p>';
  const list = dayEvents(events, selected);
  const allDay = list.filter((e) => e.allDay);
  const timed = list.filter((e) => !e.allDay);
  const title = new Date(selected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const hols = holidays(selected, list);
  return `<section class="mdetail" aria-live="polite">
    <header class="mdetail-head"><h3>${esc(title)}</h3><button class="btn small" type="button" data-month="add">${icon('plus')}Add event</button><button class="icon-btn small" type="button" data-month="close" aria-label="Close day">${icon('close')}</button></header>
    ${hols.length ? `<p class="mdetail-hol">${hols.map((h) => esc(h.name)).join(' · ')}</p>` : ''}
    ${allDayChips(allDay)}
    ${timed.length ? `<ol class="ev-list">${timed.map((e) => timedRow(e, now, settingsRef.clock24)).join('')}</ol>` : ''}
    ${list.length || hols.length ? '' : '<p class="quiet">Nothing scheduled.</p>'}
  </section>`;
}

export function renderMonth() {
  const body = $('#month-body');
  if (!body || !view) return;
  const now = Date.now();
  const { start, end, weeks } = monthGrid(view.y, view.m);
  const ready = ensureMonth(view.y, view.m, renderMonth);
  if (settingsRef.show.sky) loadHolidays(renderMonth, new Date(start).getFullYear(), view.y, new Date(end - 1).getFullYear());
  const events = eventsBetween(start, end);
  const first = new Date(view.y, view.m, 1);
  const isThisMonth = first.getFullYear() === new Date(now).getFullYear() && first.getMonth() === new Date(now).getMonth();

  $('#month-title').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#month-today').hidden = isThisMonth;
  $('#month-status').textContent = ready ? '' : 'Loading…';

  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(start, w * 7);
    const week = weekBars(events, ws);
    const cells = [];
    for (let c = 0; c < 7; c++) cells.push(cell(addDays(ws, c), events, now, week, c));
    rows.push(`<div class="mweek" style="--lanes: ${week.lanes}">${cells.join('')}${week.bars.map(bar).join('')}</div>`);
  }
  body.innerHTML = `<div class="mgrid" role="group" aria-label="${esc($('#month-title').textContent)}"><div class="mweek mhead">${weekdayLabels()}</div>${rows.join('')}</div>${detail(events, now)}`;
}

export function initMonth(S) {
  settingsRef = S;
  const now = new Date();
  view = { y: now.getFullYear(), m: now.getMonth() };
  $('#month-prev').innerHTML = icon('chevron-left');
  $('#month-next').innerHTML = icon('chevron-right');
  $('#card-month').addEventListener('click', (e) => {
    const b = e.target.closest('[data-month], [data-day]');
    if (!b) return;
    if (b.dataset.day) {
      const d0 = Number(b.dataset.day);
      // The second click of a double-click: keep the day open and add an event on it. If the
      // first click flipped to the next month, the day under the pointer is a different one,
      // so use the day first clicked.
      if (e.detail === 2) {
        const day = firstClick ?? d0;
        firstClick = null;
        selected = day;
        renderMonth();
        openEventEditor({ day });
        return;
      }
      firstClick = d0;
      selected = selected === d0 ? null : d0;
      // A day from the neighboring month flips the view to that month.
      const d = new Date(d0);
      if (d.getMonth() !== view.m) view = { y: d.getFullYear(), m: d.getMonth() };
    } else if (b.dataset.month === 'prev' || b.dataset.month === 'next') {
      const d = new Date(view.y, view.m + (b.dataset.month === 'next' ? 1 : -1), 1);
      view = { y: d.getFullYear(), m: d.getMonth() };
      selected = null;
    } else if (b.dataset.month === 'today') {
      view = { y: new Date().getFullYear(), m: new Date().getMonth() };
      selected = null;
    } else if (b.dataset.month === 'close') {
      selected = null;
    } else if (b.dataset.month === 'add') {
      openEventEditor({ day: selected });
      return;
    }
    renderMonth();
    if (b.dataset.day) $(`[data-day="${b.dataset.day}"]`)?.focus();
  });
  renderMonth();
}
