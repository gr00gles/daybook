// New vacancies from StateJobsNY, New York State's jobs site: the jobs open to the general
// public, newest first, grouped by the day they were posted. The site has no API or public
// feed; its vacancy page carries the whole list as one HTML table, which is read here by the
// column headings, so a column moving doesn't break it. Keywords and counties from Settings
// filter the list as it's drawn, so changing them doesn't refetch.
import { $, esc, cached, updatedText, errorText, addDays } from './util.js';

const SITE = 'https://statejobs.ny.gov/public/';
const LIST = `${SITE}vacancyTable.cfm`;
const KEEP = 14; // days of postings kept; Settings offers up to this many
const SHOWN = 8;

// How far back the card looks: [days, label in Settings, words for when there's nothing].
export const JOB_DAYS = [
  [1, 'Today only', 'today'],
  [2, 'Today and yesterday', 'since yesterday'],
  [3, 'The last 3 days', 'in the last 3 days'],
  [7, 'The last week', 'in the last week'],
  [14, 'The last two weeks', 'in the last two weeks'],
];

// Column headings, matched in this order; each column goes to the first that names it.
const COLUMNS = {
  title: /title/,
  posted: /posted|post(ing)? date/,
  due: /deadline|due|clos/,
  grade: /grade|\bsg\b/,
  agency: /agency|department/,
  county: /county|location/,
};

const isoDay = (t) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
// The site files agencies like an index ("Transportation, Department of"); read them the usual way.
const agencyName = (s) => s.replace(/^(.+), ((?:department|office|division|board|commission|council) of(?: the)?)$/i, '$2 $1');

// A cell's date as YYYY-MM-DD: from a sort key the table may carry, or the text (10/22/26,
// 10/22/2026, 2026-10-22 or Oct 22, 2026).
function dayOf(cell) {
  if (!cell) return '';
  for (const s of [cell.dataset.order || cell.dataset.sort || '', cell.textContent]) {
    const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const us = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/);
    if (us) return `${us[3].length === 2 ? 2000 + Number(us[3]) : us[3]}-${pad(us[1])}-${pad(us[2])}`;
    const t = /[a-z]{3}/i.test(s) && /\d{4}/.test(s) ? Date.parse(s) : NaN;
    if (t) return isoDay(t);
  }
  return '';
}

export function parseVacancies(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const jobs = new Map();
  for (const table of doc.querySelectorAll('table')) {
    const heads = [...((table.tHead?.rows[0] || table.rows[0])?.cells || [])].map((c) => clean(c.textContent).toLowerCase());
    const at = {};
    for (const [k, re] of Object.entries(COLUMNS)) at[k] = heads.findIndex((h, i) => re.test(h) && !Object.values(at).includes(i));
    for (const tr of table.rows) {
      const link = tr.querySelector('a[href*="vacancyDetails" i]');
      const id = link?.getAttribute('href').match(/[?&]id=(\d+)/i)?.[1];
      // A row of a layout table holding the vacancy table isn't a vacancy.
      if (!id || jobs.has(id) || link.closest('tr') !== tr) continue;
      const cells = [...tr.cells];
      const text = (k) => (at[k] >= 0 ? clean(cells[at[k]]?.textContent) : '');
      // Without headings, the row's first date is when it was posted and the second its deadline.
      const dates = at.posted >= 0 ? [] : cells.map(dayOf).filter(Boolean);
      const linkText = clean(link.textContent);
      jobs.set(id, {
        id,
        title: text('title') || (/\D/.test(linkText) ? linkText : `Vacancy ${id}`),
        grade: text('grade'),
        posted: at.posted >= 0 ? dayOf(cells[at.posted]) : dates[0] || '',
        due: at.due >= 0 ? dayOf(cells[at.due]) : dates[1] || '',
        agency: agencyName(text('agency')),
        county: text('county'),
      });
    }
  }
  return [...jobs.values()];
}

async function fetchJobs() {
  const res = await fetch(LIST, { cache: 'no-store' });
  if (!res.ok) throw new Error(`StateJobsNY returned ${res.status}`);
  const all = parseVacancies(await res.text());
  if (!all.some((j) => j.posted)) throw new Error('Daybook couldn’t read the vacancy list; StateJobsNY may have changed its page');
  const since = isoDay(addDays(Date.now(), -KEEP));
  return all
    .filter((j) => j.posted >= since)
    .sort((a, b) => b.posted.localeCompare(a.posted) || Number(b.id) - Number(a.id));
}

const terms = (s) =>
  String(s || '')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim().replace(/\s+county$/, ''))
    .filter(Boolean);

function pick(jobs, J) {
  const words = terms(J.keywords);
  const places = terms(J.counties);
  const since = isoDay(addDays(Date.now(), -(J.days - 1)));
  return jobs.filter((j) => {
    if (j.posted < since) return false;
    const hay = `${j.title} ${j.agency}`.toLowerCase();
    if (words.length && !words.some((w) => hay.includes(w))) return false;
    return !places.length || places.some((p) => j.county.toLowerCase().includes(p));
  });
}

const dateOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function dayLabel(iso) {
  const day = dateOf(iso);
  const diff = Math.round((new Date().setHours(0, 0, 0, 0) - day) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, diff < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

function item(j) {
  const where = [j.agency, j.county].filter(Boolean).join(' · ');
  const grade = j.grade && (/^\d+$/.test(j.grade) ? `Grade ${j.grade}` : j.grade);
  const due = j.due && `Apply by ${dateOf(j.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return `<li><a class="jb" href="${SITE}vacancyDetailsView.cfm?id=${esc(j.id)}" target="_blank" rel="noopener">
    <span class="jb-title">${esc(j.title)}</span>
    ${where ? `<span class="jb-meta">${esc(where)}</span>` : ''}
    ${grade || due ? `<span class="jb-tags">${grade ? `<span class="jb-grade">${esc(grade)}</span>` : ''}${due ? `<span>${esc(due)}</span>` : ''}</span>` : ''}
  </a></li>`;
}

function list(jobs, all) {
  const shown = all ? jobs : jobs.slice(0, SHOWN);
  let html = '';
  let day = '';
  for (const j of shown) {
    if (j.posted !== day) {
      if (day) html += '</ol>';
      day = j.posted;
      html += `<p class="jb-day">${esc(dayLabel(day))}</p><ol class="jb-list">`;
    }
    html += item(j);
  }
  if (day) html += '</ol>';
  if (jobs.length > SHOWN)
    html += `<button class="linklike jb-toggle" type="button" data-jobs="toggle">${all ? 'Show fewer' : `Show all ${jobs.length}`}</button>`;
  return html;
}

let state = { jobs: [], all: false };

function paintList() {
  const box = $('#jobs-list');
  if (box) box.innerHTML = list(state.jobs, state.all);
}

function render(S, data, meta) {
  const body = $('#jobs-body');
  const J = S.jobs;
  $('#jobs-updated').textContent = meta.error && data ? "couldn't refresh" : data ? updatedText(meta.at) : '';
  $('#jobs-filter').textContent = [J.keywords, J.counties].map(clean).filter(Boolean).join(' · ');
  if (!data) {
    $('#jobs-count').textContent = '';
    body.innerHTML = `<div class="notice warn"><p>State jobs aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p><p><a href="${LIST}">Open StateJobsNY</a></p></div>`;
    return;
  }
  state = { ...state, jobs: pick(data, J) };
  $('#jobs-count').textContent = state.jobs.length || '';
  if (!state.jobs.length) {
    const when = JOB_DAYS.find(([n]) => n === J.days)?.[2] || `in the last ${J.days} days`;
    const filtered = clean(J.keywords) || clean(J.counties);
    body.innerHTML = `<p class="quiet is-empty">No new postings${filtered ? ' match your filters' : ''} ${esc(when)}.${filtered ? ' <button class="linklike" type="button" data-open-settings="jobs">Change filters</button>' : ''}</p>`;
    return;
  }
  body.innerHTML = '<div id="jobs-list"></div>';
  paintList();
}

export function refreshJobs(S, force = false) {
  cached({
    key: 'jobs',
    sig: 'v1',
    maxAge: 2 * 3600e3,
    force,
    fetch: fetchJobs,
    render: (data, meta) => render(S, data, meta),
  });
}

export function initJobs() {
  $('#jobs-body').addEventListener('click', (e) => {
    if (!e.target.closest('[data-jobs="toggle"]')) return;
    state.all = !state.all;
    paintList();
  });
}
