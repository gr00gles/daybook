// The month calendar: every day of the month with its events, flippable to other months.
// Clicking a day shows that day's full schedule under the grid.
import { $, esc, colorVar, startOfDay, addDays } from './util.js';
import { monthGrid, eventsBetween, ensureMonth, FIRST_DAY, timedRow, allDayChips } from './calendar.js';
import { icon } from './icons.js';
import { holidaysOn, loadHolidays, coveredBy } from './sky.js';
import { openEventEditor } from './events.js';

const SHOWN_PER_DAY = 3;
let settingsRef;
let view;
let selected = null;

const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

// Holidays the calendars don't already show that day.
const holidays = (d0, list) =>
  settingsRef.show.sky ? holidaysOn(d0).filter((h) => !coveredBy(h, list.filter((e) => e.allDay).map((e) => e.title))) : [];

function dayEvents(events, d0) {
  const d1 = addDays(d0, 1);
  // All-day and multi-day all-day events fill every day they cover; timed events sit on the
  // day they start.
  return events.filter((e) => (e.allDay ? e.start < d1 && e.end > d0 : e.start >= d0 && e.start < d1));
}

function weekdayLabels() {
  // 1 January 2023 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2023, 0, 1 + ((FIRST_DAY + i) % 7));
    return `<span class="mwd" aria-hidden="true">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>`;
  }).join('');
}

function cell(d0, events, now) {
  const d = new Date(d0);
  const outside = d.getMonth() !== view.m;
  const today = sameDay(d0, now);
  const past = d0 < startOfDay(now);
  const list = dayEvents(events, d0);
  const hols = holidays(d0, list);
  const shown = list.slice(0, SHOWN_PER_DAY);
  const label = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${hols.map((h) => `, ${h.name}`).join('')}: ${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : 'nothing scheduled'}`;
  const cls = ['mday', outside && 'out', today && 'today', past && 'past', selected === d0 && 'sel', hols.some((h) => !h.clock) && 'hol'].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" data-day="${d0}" aria-label="${esc(label)}"${selected === d0 ? ' aria-pressed="true"' : ''}${hols.length ? ` title="${esc(hols.map((h) => h.name).join(', '))}"` : ''}>
    <span class="mnum">${d.getDate()}</span>
    ${hols.map((h) => `<span class="mhol${h.clock ? ' clock' : ''}">${esc(h.name)}</span>`).join('')}
    <span class="mevs">${shown
      .map((e) => `<span class="mev${e.allDay ? ' all' : ''}" style="--c: ${colorVar(e.color)}">${esc(e.title)}</span>`)
      .join('')}${list.length > shown.length ? `<span class="mmore">+${list.length - shown.length}</span>` : ''}</span>
  </button>`;
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

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) cells.push(cell(addDays(start, i), events, now));
  body.innerHTML = `<div class="mgrid" role="group" aria-label="${esc($('#month-title').textContent)}">${weekdayLabels()}${cells.join('')}</div>${detail(events, now)}`;
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
  // Double-click a day to add an event on it.
  $('#card-month').addEventListener('dblclick', (e) => {
    const b = e.target.closest('[data-day]');
    if (b) openEventEditor({ day: Number(b.dataset.day) });
  });
  renderMonth();
}
