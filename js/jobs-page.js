// The NYS jobs page: every recent StateJobsNY posting Daybook has, as one table with every
// column the site lists. Search it, sort it by any column, look further back, or turn your
// rules off to see everything. It uses the list the new tab keeps and fetches again only when
// that copy is old.
import { $, esc, updatedText, errorText } from './util.js';
import { loadSettings } from './settings.js';
import { icon } from './icons.js';
import { loadJobs, pick, activeRules, JOB_DAYS, daysText, postingUrl, agencyName, numberIn, shortDate } from './jobs.js';

const S = await loadSettings();
if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
$('#jp-back').insertAdjacentHTML('afterbegin', icon('chevron-left'));
$('.jp-search').insertAdjacentHTML('afterbegin', icon('search'));
$('#jp-edit').insertAdjacentHTML('afterbegin', icon('edit'));

const view = { q: '', days: S.jobs.days, rules: true, sort: null, dir: -1 };
let data = null;

const rules = activeRules(S.jobs).length;
$('#jp-rules-wrap').hidden = !rules;
$('#jp-rules-label').textContent = `Only postings that pass my ${rules === 1 ? 'rule' : `${rules} rules`}`;
$('#jp-days').innerHTML = JOB_DAYS.map(([n, l]) => `<option value="${n}"${n === view.days ? ' selected' : ''}>${esc(l)}</option>`).join('');

// The site's columns, or the ones Daybook could make out when the table had no headings.
const columns = () =>
  data.columns.length ? data.columns : [{ label: 'Title', role: 'title' }, { label: 'Posted', role: 'posted' }, { label: 'Deadline', role: 'due' }];

const cellText = (j, c) => (c.role === 'title' ? j.title : c.role === 'agency' ? agencyName(j.agency) : j.cells[c.label] ?? '');

// Dates sort by day, numbers (grades, item numbers) by number and the rest by text, in `dir`.
// Empty cells go last either way, and so do words in a column of numbers (grades like NS).
function sorter(c, dir) {
  const date = c.role === 'posted' || c.role === 'due';
  const key = (j) => (date ? j[c.role] : cellText(j, c));
  const text = (a, b) => dir * a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return (a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return !x - !y;
    if (date) return text(x, y);
    const [nx, ny] = [numberIn(x), numberIn(y)];
    if (Number.isNaN(nx) || Number.isNaN(ny)) return Number.isNaN(nx) - Number.isNaN(ny) || text(x, y);
    return dir * (nx - ny);
  };
}

function cell(j, c) {
  if (c.role === 'title') return `<td class="jp-title"><a href="${esc(postingUrl(j.id))}" target="_blank" rel="noopener">${esc(j.title)}</a></td>`;
  if (c.role === 'posted' || c.role === 'due') return `<td class="jp-nowrap">${j[c.role] ? esc(shortDate(j[c.role])) : ''}</td>`;
  return `<td${c.role === 'grade' ? ' class="jp-nowrap"' : ''}>${esc(cellText(j, c))}</td>`;
}

function paint() {
  if (!data) return;
  const J = { ...S.jobs, days: view.days };
  const base = pick(data.jobs, J, { rules: view.rules });
  const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
  const cols = columns();
  let shown = words.length
    ? base.filter((j) => {
        const text = cols.map((c) => cellText(j, c)).join(' ').toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : base;
  const by = cols.find((c) => c.label === view.sort);
  if (by) {
    const cmp = sorter(by, view.dir);
    shown = [...shown].sort((a, b) => cmp(a, b) || Number(b.id) - Number(a.id));
  }
  const when = daysText(view.days);
  const passing = view.rules && rules ? ' that pass your rules' : '';
  $('#jp-status').textContent = words.length
    ? `${shown.length} of ${base.length} postings ${when}${passing} match`
    : `${base.length} ${base.length === 1 ? 'posting' : 'postings'} ${when}${passing}`;
  if (!shown.length) {
    $('#jp-body').innerHTML = `<p class="quiet">${words.length ? 'Nothing matches that search.' : `No postings${passing} ${esc(when)}.`}</p>`;
    return;
  }
  const sortState = (c) => (c.label === view.sort ? (view.dir > 0 ? 'ascending' : 'descending') : 'none');
  $('#jp-body').innerHTML = `<table class="jp-table">
    <thead><tr>${cols
      .map((c) => `<th aria-sort="${sortState(c)}"><button type="button" data-sort="${esc(c.label)}">${esc(c.label)}${c.label === view.sort ? icon('chevron-down') : ''}</button></th>`)
      .join('')}</tr></thead>
    <tbody>${shown.map((j) => `<tr>${cols.map((c) => cell(j, c)).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

$('#jp-q').addEventListener('input', (e) => {
  view.q = e.target.value;
  paint();
});
$('#jp-days').addEventListener('change', (e) => {
  view.days = Number(e.target.value);
  paint();
});
$('#jp-rules').addEventListener('change', (e) => {
  view.rules = e.target.checked;
  paint();
});
// A heading sorts by its column; again turns the order around. Dates start newest first.
$('#jp-body').addEventListener('click', (e) => {
  const label = e.target.closest('[data-sort]')?.dataset.sort;
  if (label === undefined) return;
  const role = columns().find((c) => c.label === label)?.role;
  view.dir = label === view.sort ? -view.dir : role === 'posted' || role === 'due' ? -1 : 1;
  view.sort = label;
  paint();
});

loadJobs(false, (d, meta) => {
  $('#jp-updated').textContent = meta.error && d ? "couldn't refresh" : d ? updatedText(meta.at) : '';
  if (!d) {
    $('#jp-status').textContent = 'NYS jobs';
    $('#jp-body').innerHTML = `<p class="notice warn">The postings aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p>`;
    return;
  }
  data = d;
  paint();
});
