// New vacancies from StateJobsNY, New York State's jobs site: the jobs open to the general
// public, newest first, grouped by the day they were posted. The site has no API or public
// feed; its vacancy page carries the whole list as one HTML table, which is read here by the
// column headings, so a column moving doesn't break it. Every column is kept, so the rules in
// Settings can use any field the site lists. Rules filter the list as it's drawn, so changing
// them doesn't refetch. The card shows the newest few; jobs.html lists them all.
import { $, esc, cached, local, updatedText, errorText, addDays } from './util.js';
import { icon } from './icons.js';

const SITE = 'https://statejobs.ny.gov/public/';
export const LIST = `${SITE}vacancyTable.cfm`;
const KEEP = 14; // days of postings kept; Settings offers up to this many
const SHOWN = 8;

// How far back to look: [days, label in Settings, words for a sentence].
export const JOB_DAYS = [
  [1, 'Today only', 'today'],
  [2, 'Today and yesterday', 'since yesterday'],
  [3, 'The last 3 days', 'in the last 3 days'],
  [7, 'The last week', 'in the last week'],
  [14, 'The last two weeks', 'in the last two weeks'],
];
export const daysText = (n) => JOB_DAYS.find(([d]) => d === n)?.[2] || `in the last ${n} days`;

// What a rule can ask of a field. Several values separated by commas match any of them.
export const RULE_OPS = {
  has: 'contains',
  lacks: 'doesn’t contain',
  is: 'is',
  not: 'isn’t',
  min: 'is at least',
  max: 'is at most',
};

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
export const agencyName = (s) => s.replace(/^(.+), ((?:department|office|division|board|commission|council) of(?: the)?)$/i, '$2 $1');
export const postingUrl = (id) => `${SITE}vacancyDetailsView.cfm?id=${encodeURIComponent(id)}`;
// A field that is a number: 18 for "18" or "SG-18", 45000 for "$45,000" or "$45,000 - $60,000".
// Anything else, like the grades "NS" and "M-1", has none.
const NUMBER = /^(?:sg-?)?\$?\d[\d,]*(?:\.\d+)?(?:\s*[-–]\s*\$?\d[\d,]*(?:\.\d+)?)?$/i;
export const numberIn = (s) => (NUMBER.test(clean(s)) ? parseFloat(clean(s).replace(/^sg-?|[$,]/gi, '')) : NaN);

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

// { columns: [{ label, role }], jobs: [{ id, title, grade, posted, due, agency, county, cells }] }.
// `cells` has every column's text by its heading; `role` says which known field a column is.
export function parseVacancies(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const isLink = 'a[href*="vacancyDetails" i]';
  const jobs = new Map();
  let columns = [];
  for (const table of doc.querySelectorAll('table')) {
    const head = table.tHead?.rows[0] || table.rows[0];
    const heads = head && !head.querySelector(isLink) ? [...head.cells].map((c) => clean(c.textContent)) : [];
    const at = {};
    for (const [k, re] of Object.entries(COLUMNS)) at[k] = heads.findIndex((h, i) => re.test(h.toLowerCase()) && !Object.values(at).includes(i));
    let found = 0;
    for (const tr of table.rows) {
      const link = tr.querySelector(isLink);
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
        agency: text('agency'),
        county: text('county'),
        cells: Object.fromEntries(heads.map((h, i) => [h, clean(cells[i]?.textContent)]).filter(([h]) => h)),
      });
      found++;
    }
    if (found && !columns.length) columns = heads.map((label, i) => ({ label, role: Object.keys(at).find((k) => at[k] === i) || '' })).filter((c) => c.label);
  }
  return { columns, jobs: [...jobs.values()] };
}

async function fetchJobs() {
  const res = await fetch(LIST, { cache: 'no-store' });
  if (!res.ok) throw new Error(`StateJobsNY returned ${res.status}`);
  const { columns, jobs } = parseVacancies(await res.text());
  if (!jobs.some((j) => j.posted)) throw new Error('Daybook couldn’t read the vacancy list; StateJobsNY may have changed its page');
  const since = isoDay(addDays(Date.now(), -KEEP));
  return {
    columns,
    jobs: jobs.filter((j) => j.posted >= since).sort((a, b) => b.posted.localeCompare(a.posted) || Number(b.id) - Number(a.id)),
  };
}

export const loadJobs = (force, render) => cached({ key: 'jobs', sig: 'v2', maxAge: 2 * 3600e3, force, fetch: fetchJobs, render });

// ---- Rules ---------------------------------------------------------------------------

const norm = (s) => clean(s).toLowerCase().replace(/\s+county$/, '');
const valuesOf = (s) => String(s || '').split(',').map(norm).filter(Boolean);
export const activeRules = (J) => (J.rules || []).filter((r) => valuesOf(r.value).length);

// A field's text, or null when the site doesn't list that column (then the rule is skipped).
function fieldText(job, field) {
  const all = Object.values(job.cells || {});
  if (field === 'any') return [job.title, job.agency, ...all].map((v) => norm(`${v} ${agencyName(v)}`));
  const label = Object.keys(job.cells || {}).find((l) => l.toLowerCase() === field.toLowerCase());
  if (label === undefined) return null;
  // Agencies match as the site lists them or as the card shows them.
  return [norm(job.cells[label]), norm(agencyName(job.cells[label]))];
}

function passes(job, rule) {
  const want = valuesOf(rule.value);
  const have = want.length ? fieldText(job, rule.field) : null;
  if (!have) return true;
  const contains = want.some((w) => have.some((h) => h.includes(w)));
  const equals = want.some((w) => have.includes(w));
  if (rule.op === 'has') return contains;
  if (rule.op === 'lacks') return !contains;
  if (rule.op === 'is') return equals;
  if (rule.op === 'not') return !equals;
  const n = numberIn(have[0]);
  const limit = numberIn(rule.value);
  if (Number.isNaN(limit)) return true;
  return !Number.isNaN(n) && (rule.op === 'min' ? n >= limit : n <= limit);
}

// The postings from the last J.days days, and with `rules`, only those passing every rule.
export function pick(jobs, J, { rules = true } = {}) {
  const since = isoDay(addDays(Date.now(), -(J.days - 1)));
  const use = rules ? activeRules(J) : [];
  return jobs.filter((j) => j.posted >= since && use.every((r) => passes(j, r)));
}

// The columns rules can use: every one the site lists except the dates (Posted has its own
// setting), or the usual ones before the list has loaded.
export const ruleFields = (data) =>
  data?.columns?.length ? data.columns.filter((c) => c.role !== 'posted' && c.role !== 'due').map((c) => c.label) : ['Title', 'Grade', 'Agency', 'County'];

// The NYS jobs part of Settings: how far back to look, and the rules, with how many of the
// postings Daybook has pass them.
export async function mountJobs(el, draft, changed) {
  const J = draft.jobs;
  const data = (await local.get('cache:jobs'))?.data;
  if (!el.isConnected) return;
  const jobs = data?.jobs || [];
  const fields = ['any', ...ruleFields(data)];
  const example = (r) =>
    r.op === 'min' || r.op === 'max' ? '14' : { title: 'analyst, engineer', agency: 'Health, Parks', county: 'Albany, Saratoga' }[r.field.toLowerCase()] || 'analyst';
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

  const paintCount = () => {
    const box = el.querySelector('.jr-count');
    if (!data?.jobs) {
      box.textContent = 'Once the card has loaded the postings, this shows how many pass.';
      return;
    }
    const all = pick(jobs, J, { rules: false }).length;
    const kept = pick(jobs, J).length;
    box.textContent = activeRules(J).length
      ? `${kept} of the ${all} postings ${daysText(J.days)} pass ${activeRules(J).length === 1 ? 'this rule' : 'these rules'}.`
      : `${all} postings ${daysText(J.days)}. Add a rule to see fewer.`;
  };

  const paint = () => {
    el.innerHTML = `<label class="field jr-days"><span>Posted</span><select data-r-days>${JOB_DAYS.map(([n, l]) => option(String(n), l, String(J.days))).join('')}</select></label>
      <div class="jr-rules">${J.rules
        .map(
          (r, i) => `<div class="jr-rule">
          <label class="field"><select data-r="${i}" data-k="field" aria-label="Field">${[...new Set([...fields, r.field])]
            .map((f) => option(f, f === 'any' ? 'Any field' : fields.includes(f) ? f : `${f} (not on the site now)`, r.field))
            .join('')}</select></label>
          <label class="field"><select data-r="${i}" data-k="op" aria-label="Rule">${Object.entries(RULE_OPS).map(([k, l]) => option(k, l, r.op)).join('')}</select></label>
          <label class="field"><input type="text" data-r="${i}" data-k="value" value="${esc(r.value)}" placeholder="${esc(example(r))}" aria-label="Value" spellcheck="false" autocomplete="off"></label>
          <button class="icon-btn" type="button" data-r-remove="${i}" aria-label="Remove this rule">${icon('close')}</button>
        </div>`,
        )
        .join('')}</div>
      <button class="btn small" type="button" data-r-add>${icon('plus')}Add a rule</button>
      <p class="hint jr-count" aria-live="polite"></p>`;
    paintCount();
  };

  const edit = (e) => {
    const t = e.target;
    if (t.matches('[data-r-days]')) J.days = Number(t.value);
    else if (t.dataset.r) J.rules[Number(t.dataset.r)][t.dataset.k] = t.value;
    else return;
    changed();
    // A new field or test changes the value's example; typing a value only changes the count.
    if (e.type === 'change' && t.dataset.k && t.dataset.k !== 'value') {
      t.closest('.jr-rule').querySelector('[data-k="value"]').placeholder = example(J.rules[Number(t.dataset.r)]);
    }
    paintCount();
  };
  el.addEventListener('input', edit);
  el.addEventListener('change', edit);
  el.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-r-remove]');
    if (remove) J.rules.splice(Number(remove.dataset.rRemove), 1);
    else if (e.target.closest('[data-r-add]')) J.rules.push({ field: fields.includes('Title') ? 'Title' : fields[1] || 'any', op: 'has', value: '' });
    else return;
    changed();
    paint();
    if (!remove) el.querySelector('.jr-rule:last-child [data-k="value"]')?.focus();
  });
  paint();
}

// ---- The card ------------------------------------------------------------------------

const dateOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const shortDate = (iso) => dateOf(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function dayLabel(iso) {
  const day = dateOf(iso);
  const diff = Math.round((new Date().setHours(0, 0, 0, 0) - day) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, diff < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

function item(j) {
  const where = [agencyName(j.agency), j.county].filter(Boolean).join(' · ');
  const grade = j.grade && (/^\d+$/.test(j.grade) ? `Grade ${j.grade}` : j.grade);
  const due = j.due && `Apply by ${shortDate(j.due)}`;
  return `<li><a class="jb" href="${esc(postingUrl(j.id))}" target="_blank" rel="noopener">
    <span class="jb-title">${esc(j.title)}</span>
    ${where ? `<span class="jb-meta">${esc(where)}</span>` : ''}
    ${grade || due ? `<span class="jb-tags">${grade ? `<span class="jb-grade">${esc(grade)}</span>` : ''}${due ? `<span>${esc(due)}</span>` : ''}</span>` : ''}
  </a></li>`;
}

function list(jobs) {
  let html = '';
  let day = '';
  for (const j of jobs) {
    if (j.posted !== day) {
      if (day) html += '</ol>';
      day = j.posted;
      html += `<p class="jb-day">${esc(dayLabel(day))}</p><ol class="jb-list">`;
    }
    html += item(j);
  }
  return day ? `${html}</ol>` : html;
}

// The card shows as many as fit; the whole list is a click away.
function paintLinks(n) {
  $('#jobs-links').innerHTML = `${n === null ? '' : `<a class="foot-link" href="jobs.html">${icon('chevron-right')}${n ? `See all ${n}` : 'See all postings'}</a>`}
    <button class="foot-link" type="button" data-open-settings="jobs">${icon('edit')}Rules</button>
    <a class="foot-link" href="${LIST}" target="_blank" rel="noopener">${icon('external')}StateJobsNY</a>`;
}

function render(S, data, meta) {
  const body = $('#jobs-body');
  const J = S.jobs;
  const rules = activeRules(J).length;
  $('#jobs-updated').textContent = meta.error && data ? "couldn't refresh" : data ? updatedText(meta.at) : '';
  $('#jobs-filter').textContent = rules ? `${rules} ${rules === 1 ? 'rule' : 'rules'}` : '';
  if (!data) {
    $('#jobs-count').textContent = '';
    paintLinks(null);
    body.innerHTML = `<p class="notice warn">NYS jobs aren’t loading: ${esc(errorText(meta.error).replace(/\.$/, ''))}.</p>`;
    return;
  }
  const jobs = pick(data.jobs, J);
  $('#jobs-count').textContent = jobs.length || '';
  paintLinks(jobs.length);
  body.innerHTML = jobs.length
    ? list(jobs.slice(0, SHOWN))
    : `<p class="quiet is-empty">No new postings${rules ? ' pass your rules' : ''} ${esc(daysText(J.days))}.</p>`;
}

export function refreshJobs(S, force = false) {
  loadJobs(force, (data, meta) => render(S, data, meta));
}
