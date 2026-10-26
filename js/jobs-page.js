// The NYS jobs page: every recent StateJobsNY posting Daybook has, as one table with every
// column the site lists, plus the salary and employment type from each posting's page. Search
// it, sort it by any column, look further back, or turn your rules off and show the postings
// you've reviewed to see everything. It uses the list the new tab keeps and fetches again only
// when that copy is old. jobs.html#closing (from the search bar) starts on the postings that
// close soon, soonest first.
import { $, esc, updatedText, errorText } from './util.js';
import { loadSettings } from './settings.js';
import { icon } from './icons.js';
import {
  loadJobs, pick, ruleCount, JOB_DAYS, whenText, postingUrl, agencyName, numberIn, shortDate, loadDetails, withDetails, ensureDetails, onDetails, salaryText,
  REVIEWED, loadReviewed, closing,
} from './jobs.js';

const S = await loadSettings();
if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
$('#jp-back').insertAdjacentHTML('afterbegin', icon('chevron-left'));
$('.jp-search').insertAdjacentHTML('afterbegin', icon('search'));
$('#jp-edit').insertAdjacentHTML('afterbegin', icon('edit'));

// Like the card, the page starts without the postings you've marked as reviewed.
const soon = S.jobs.dueSoon > 0 ? S.jobs.dueSoon : 7;
const view = { q: '', days: location.hash === '#closing' ? 'closing' : S.jobs.days, rules: true, unreviewed: true, sort: null, dir: -1 };
let data = null;
let details = {};
let reviewed = await loadReviewed();

const rules = ruleCount(S.jobs);
$('#jp-rules-wrap').hidden = !rules;
$('#jp-rules-label').textContent = `Only postings that pass my ${rules === 1 ? 'rule' : `${rules} rules`}`;
// Dates set in Settings are one more choice here.
$('#jp-days').innerHTML = `${JOB_DAYS.filter(([n]) => n || S.jobs.days === 0)
  .map(([n, l]) => `<option value="${n}"${n === view.days ? ' selected' : ''}>${esc(n ? l : 'Your dates in Settings')}</option>`)
  .join('')}<option value="closing"${view.days === 'closing' ? ' selected' : ''}>Closing within ${soon === 7 ? 'a week' : `${soon} days`}</option>`;
// The postings in view: from the days picked, or every day kept for the ones closing soon.
const inView = (jobs, opts) => (view.days === 'closing' ? closing(jobs, S.jobs, soon, opts) : pick(jobs, { ...S.jobs, days: view.days }, opts));

// The site's columns (or the ones Daybook could make out when the table had no headings), with
// the salary and employment type from the postings' pages after the grade, once some are read.
function columns() {
  const list = data.columns.length ? [...data.columns] : [{ label: 'Title', role: 'title' }, { label: 'Posted', role: 'posted' }, { label: 'Deadline', role: 'due' }];
  const labels = new Set(data.jobs.flatMap((j) => Object.keys(details[j.id]?.fields || {})));
  const extra = [/salary/i, /employment type/i]
    .map((re) => [...labels].find((l) => re.test(l) && !list.some((c) => c.label.toLowerCase() === l.toLowerCase())))
    .filter(Boolean)
    .map((label) => ({ label, role: /salary/i.test(label) ? 'salary' : 'info' }));
  const at = list.findIndex((c) => c.role === 'grade');
  list.splice(at >= 0 ? at + 1 : list.length, 0, ...extra);
  return list;
}

const cellText = (j, c) =>
  c.role === 'title' ? j.title : c.role === 'agency' ? agencyName(j.agency) : c.role === 'salary' || c.role === 'info' ? j.info?.[c.label] ?? '' : j.cells[c.label] ?? '';

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
  if (c.role === 'salary') return `<td class="jp-nowrap">${esc(salaryText(j))}</td>`;
  return `<td${c.role === 'grade' ? ' class="jp-nowrap"' : ''}>${esc(cellText(j, c))}</td>`;
}

function paint() {
  if (!data) return;
  const jobs = withDetails(data.jobs, details);
  const base = inView(jobs, { rules: view.rules }).filter((j) => !view.unreviewed || !reviewed[j.id]);
  const waiting = inView(jobs, { rules: false }).filter((j) => !j.info && !details[j.id]?.error).length;
  const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
  const cols = columns();
  let shown = words.length
    ? base.filter((j) => {
        const text = [...cols.map((c) => cellText(j, c)), ...Object.values(j.info || {})].join(' ').toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : base;
  const by = cols.find((c) => c.label === view.sort);
  if (by) {
    const cmp = sorter(by, view.dir);
    shown = [...shown].sort((a, b) => cmp(a, b) || Number(b.id) - Number(a.id));
  }
  const when = view.days === 'closing' ? `closing within ${soon === 7 ? 'a week' : `${soon} days`}` : whenText({ ...S.jobs, days: view.days });
  const kept = [view.rules && rules && 'pass your rules', view.unreviewed && 'you haven’t reviewed'].filter(Boolean);
  const passing = kept.length ? ` that ${kept.join(' and ')}` : '';
  $('#jp-status').textContent = words.length
    ? `${shown.length} of ${base.length} postings ${when}${passing} match`
    : `${base.length} ${base.length === 1 ? 'posting' : 'postings'} ${when}${passing}`;
  $('#jp-reading').textContent = waiting ? `Reading ${waiting} more ${waiting === 1 ? 'posting' : 'postings'} for salaries and details…` : '';
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
// The pages of the postings in view, read in the background; the table fills in as they come.
const readPages = () => data && ensureDetails(inView(data.jobs, { rules: false }).map((j) => j.id));
onDetails(async () => {
  details = await loadDetails();
  paint();
});

$('#jp-days').addEventListener('change', (e) => {
  view.days = e.target.value === 'closing' ? 'closing' : Number(e.target.value);
  paint();
  readPages();
});
$('#jp-rules').addEventListener('change', (e) => {
  view.rules = e.target.checked;
  paint();
});
$('#jp-unreviewed').addEventListener('change', (e) => {
  view.unreviewed = e.target.checked;
  paint();
});
// Marked or unmarked on a new tab while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[REVIEWED]) return;
  reviewed = changes[REVIEWED].newValue || {};
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

loadJobs(false, async (d, meta) => {
  $('#jp-updated').textContent = meta.error && d ? "couldn't refresh" : d ? updatedText(meta.at) : '';
  if (!d) {
    $('#jp-status').textContent = 'NYS jobs';
    $('#jp-body').innerHTML = `<p class="notice warn">The postings aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p>`;
    return;
  }
  data = d;
  details = await loadDetails();
  paint();
  readPages();
});
