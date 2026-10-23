// New vacancies from StateJobsNY, New York State's jobs site: the jobs open to the general
// public, newest first, grouped by the day they were posted. The site has no API or public
// feed; its vacancy page carries the whole list as one HTML table, which is read here by the
// column headings, so a column moving doesn't break it. Salary and the other details are on
// each posting's own page, which is read once per posting. Every column and detail is kept, so
// the rules in Settings can use any field the site lists. Rules filter the list as it's drawn,
// so changing them doesn't refetch. The card shows the newest few; jobs.html lists them all.
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
  over: 'is more than',
  under: 'is less than',
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
// The number in a field, for "is at least" and for sorting: a plain number ("18", "SG-18",
// "37.5", "70%", "60k"), or else the first dollar amount, which for a salary range ("From
// $55817 to $67990 Annually") is where it starts: what new State hires are paid. Grades like
// "NS" and "M-1", and other text, have none.
export function numberIn(s) {
  const t = clean(s);
  if (/^(?:sg-?)?\d[\d,]*(?:\.\d+)?%?$/i.test(t)) return parseFloat(t.replace(/^sg-?|[,%]/gi, ''));
  const k = t.match(/^\$?(\d+(?:\.\d+)?)k$/i);
  if (k) return Number(k[1]) * 1000;
  const money = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
  return money ? parseFloat(money[1].replace(/,/g, '')) : NaN;
}

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

// ---- Each posting's page --------------------------------------------------------------
// The list has only the table's columns. Salary, employment type, telecommuting and the rest
// are on each posting's own page, which is read once, a few at a time, and kept by id.

const DETAILS = 'jobs:details'; // { [id]: { at, fields: { label: value } | null, error } }
const RETRY = 6 * 3600e3; // a page that couldn't be read is tried again after this
const FORGET = 21 * 86400e3;
const LONG = 400; // longer text, like the duties, isn't kept

// Labels the site uses, for finding them in the text of a page laid out unlike the pairs below.
// The long ones at the end mostly mark where the field before them stops.
const KNOWN = [
  'Occupational Category', 'Salary Grade', 'Bargaining Unit', 'Salary Range', 'Employment Type', 'Appointment Type', 'Jurisdictional Class',
  'Travel Percentage', 'Workweek', 'Hours Per Week', 'Flextime allowed?', 'Mandatory overtime?', 'Compressed workweek allowed?',
  'Telecommuting allowed?', 'Street Address', 'Zip Code', 'Duties Description', 'Minimum Qualifications', 'Additional Comments', 'Contact Information',
];

// The label and value pairs on a posting's page: two-cell rows, term lists, elements holding
// just a short label and its value, "Label:" in bold before its value, and as a last resort
// the site's own labels found in the page's text.
export function parseDetails(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, style, noscript, nav, header, footer, form')) el.remove();
  for (const br of doc.querySelectorAll('br')) br.replaceWith(' ');
  const fields = {};
  const add = (label, value) => {
    label = clean(label).replace(/\s*:$/, '');
    value = clean(value);
    if (!/^[a-z]/i.test(label) || label.length > 60 || !value || value.length > LONG || value === label || label in fields) return;
    fields[label] = value;
  };
  const block = 'div, table, ul, ol, dl, section, article, h1, h2, h3, h4, h5, h6';
  for (const dt of doc.querySelectorAll('dt')) if (dt.nextElementSibling?.matches('dd')) add(dt.textContent, dt.nextElementSibling.textContent);
  for (const el of doc.querySelectorAll('body *')) {
    if (el.children.length !== 2 || el.matches('dl, ul, ol, select')) continue;
    const [a, b] = el.children;
    // A link is a menu, not a label.
    if (a.matches('a') || a.querySelector(`${block}, a`) || b.querySelector(block)) continue;
    if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
    add(a.textContent, b.textContent);
  }
  for (const a of doc.querySelectorAll('[class*="left" i], [class*="label" i]')) {
    const b = a.nextElementSibling;
    if (b?.matches('[class*="right" i], [class*="value" i]') && !a.querySelector('a')) add(a.textContent, b.textContent);
  }
  for (const s of doc.querySelectorAll('strong, b, label, th')) {
    const label = clean(s.textContent);
    const all = clean(s.parentElement?.textContent);
    if (label.endsWith(':') && all.startsWith(label)) add(label, all.slice(label.length));
  }
  if (!Object.keys(fields).some((l) => /salary/i.test(l))) {
    // A value runs from its label to the next label or the end of its line, whichever is first;
    // a label alone on its line takes the next line.
    for (const el of doc.querySelectorAll('div, p, li, tr, td, th, dt, dd, h1, h2, h3, h4, h5, h6, section')) el.append('\n');
    const text = (doc.body?.textContent || '').replace(/[^\S\n]+/g, ' ');
    const found = KNOWN.map((l) => [l, text.indexOf(l)]).filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]);
    found.forEach(([l, i], k) => add(l, text.slice(i + l.length, found[k + 1]?.[1]).replace(/^[\s:]+/, '').split('\n')[0]));
  }
  return fields;
}

async function fetchDetails(id) {
  const res = await fetch(postingUrl(id), { cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`StateJobsNY returned ${res.status}`), { status: res.status });
  return parseDetails(await res.text());
}

export const loadDetails = async () => (await local.get(DETAILS)) || {};
export const withDetails = (jobs, details) => jobs.map((j) => ({ ...j, info: details[j.id]?.fields || null }));

// Reads the pages of the postings in `ids` not read yet, three at a time, saving as it goes.
// One Daybook page does this at a time; the others get the results through storage. Without a
// connection it stops and tries again next time; a page the site won't give is retried later.
export function ensureDetails(ids) {
  return navigator.locks.request('jobs-details', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const now = Date.now();
    const have = await loadDetails();
    const queue = ids.filter((id) => !have[id] || (!have[id].fields && now - have[id].at > RETRY));
    if (!queue.length) return;
    const got = {};
    let saved = now;
    const save = async () => {
      saved = Date.now();
      const all = { ...(await loadDetails()), ...got };
      for (const [id, d] of Object.entries(all)) if (now - d.at > FORGET) delete all[id];
      await local.set(DETAILS, all);
    };
    const worker = async () => {
      for (let id; (id = queue.shift()); ) {
        try {
          got[id] = { at: Date.now(), fields: await fetchDetails(id) };
        } catch (err) {
          if (!err.status) queue.length = 0;
          else got[id] = { at: Date.now(), fields: null, error: errorText(err) };
        }
        if (Date.now() - saved > 3000) await save();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await save();
  });
}

// Calls `fn` when more postings' pages have been read, by this page or another.
export function onDetails(fn) {
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[DETAILS]) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 300);
  });
}

export const salaryLabel = (info) => Object.keys(info || {}).find((l) => /salary/i.test(l));

// "From $55817 to $67990 Annually" as "$55,817–$67,990"; hourly pay says so.
export function salaryText(job) {
  const raw = job.info?.[salaryLabel(job.info)] || '';
  const amounts = [...raw.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  return amounts.length ? `${amounts.slice(0, 2).map(money).join('–')}${/hour/i.test(raw) ? ' an hour' : ''}` : '';
}

// How many of `jobs` rules leave out because their pages are still to be read, or couldn't be.
// Only rules on fields from the postings' pages need them.
function unread(jobs, data, J, details) {
  const onList = (f) => f === 'any' || data.columns.some((c) => c.label.toLowerCase() === f.toLowerCase());
  if (!activeRules(J).some((r) => !onList(r.field))) return { waiting: 0, failed: 0 };
  const missing = jobs.filter((j) => !j.info);
  const failed = missing.filter((j) => details[j.id]?.error).length;
  return { waiting: missing.length - failed, failed };
}

const unreadText = ({ waiting, failed }) =>
  [
    waiting && `Reading ${waiting} more ${waiting === 1 ? 'posting' : 'postings'} for your rules…`,
    failed && `StateJobsNY wouldn’t give the ${failed === 1 ? 'page of 1 posting' : `pages of ${failed} postings`}, so your rules leave ${failed === 1 ? 'it' : 'them'} out for now.`,
  ]
    .filter(Boolean)
    .join(' ');

// ---- Rules ---------------------------------------------------------------------------

const norm = (s) => clean(s).toLowerCase().replace(/\s+county$/, '');
const valuesOf = (s) => String(s || '').split(',').map(norm).filter(Boolean);
export const activeRules = (J) => (J.rules || []).filter((r) => valuesOf(r.value).length);

// A field's text: a column of the list or a detail from the posting's page, empty when the
// posting has no such field (or its page hasn't been read yet).
function fieldText(job, field) {
  const own = { ...job.info, ...job.cells };
  if (field === 'any') return [job.title, job.agency, ...Object.values(own)].map((v) => norm(`${v} ${agencyName(v)}`));
  const label = Object.keys(own).find((l) => l.toLowerCase() === field.toLowerCase());
  const v = label === undefined ? '' : own[label];
  // Agencies match as the site lists them or as the card shows them.
  return [norm(v), norm(agencyName(v))];
}

function passes(job, rule) {
  const want = valuesOf(rule.value);
  if (!want.length) return true;
  const have = fieldText(job, rule.field);
  const contains = want.some((w) => have.some((h) => h.includes(w)));
  const equals = want.some((w) => have.includes(w));
  if (rule.op === 'has') return contains;
  if (rule.op === 'lacks') return !contains;
  if (rule.op === 'is') return equals;
  if (rule.op === 'not') return !equals;
  const n = numberIn(have[0]);
  const limit = numberIn(rule.value);
  if (Number.isNaN(limit)) return true;
  if (Number.isNaN(n)) return false;
  return { min: n >= limit, max: n <= limit, over: n > limit, under: n < limit }[rule.op] ?? true;
}

// The postings from the last J.days days, and with `rules`, only those passing every rule.
export function pick(jobs, J, { rules = true } = {}) {
  const since = isoDay(addDays(Date.now(), -(J.days - 1)));
  const use = rules ? activeRules(J) : [];
  return jobs.filter((j) => j.posted >= since && use.every((r) => passes(j, r)));
}

// The fields rules can use: the list's columns except the dates (Posted has its own setting),
// or the usual ones before the list has loaded; then, A to Z, the details on the postings'
// pages that at least a fifth of them have.
export function ruleFields(data, details = {}) {
  const columns = data?.columns?.length ? data.columns : [];
  const fields = columns.length ? columns.filter((c) => c.role !== 'posted' && c.role !== 'due').map((c) => c.label) : ['Title', 'Grade', 'Agency', 'County'];
  const taken = new Set([...fields, ...columns.map((c) => c.label)].map((l) => l.toLowerCase()));
  const count = new Map();
  let read = 0;
  for (const j of data?.jobs || []) {
    const f = details[j.id]?.fields;
    if (!f) continue;
    read++;
    for (const l of Object.keys(f)) count.set(l, (count.get(l) || 0) + 1);
  }
  const enough = Math.min(read, Math.max(2, Math.ceil(read / 5)));
  for (const [l, n] of [...count].sort(([a], [b]) => a.localeCompare(b))) {
    const low = l.toLowerCase();
    if (n >= enough && !taken.has(low) && !COLUMNS.posted.test(low) && !COLUMNS.due.test(low)) fields.push(l);
  }
  return fields;
}

// The NYS jobs part of Settings: how far back to look, and the rules, with how many of the
// postings Daybook has pass them.
export async function mountJobs(el, draft, changed) {
  const J = draft.jobs;
  const data = (await local.get('cache:jobs'))?.data;
  const details = await loadDetails();
  if (!el.isConnected) return;
  const jobs = withDetails(data?.jobs || [], details);
  const fields = ['any', ...ruleFields(data, details)];
  const example = (r) =>
    /salary/i.test(r.field)
      ? '60000'
      : ['min', 'max', 'over', 'under'].includes(r.op)
        ? '14'
        : { title: 'analyst, engineer', agency: 'Health, Parks', county: 'Albany, Saratoga' }[r.field.toLowerCase()] || 'analyst';
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

  const paintCount = () => {
    const box = el.querySelector('.jr-count');
    if (!data?.jobs) {
      box.textContent = 'Once the card has loaded the postings, this shows how many pass.';
      return;
    }
    const recent = pick(jobs, J, { rules: false });
    const kept = pick(jobs, J).length;
    const note = unreadText(unread(recent, data, J, details));
    box.textContent = activeRules(J).length
      ? `${kept} of the ${recent.length} postings ${daysText(J.days)} pass ${activeRules(J).length === 1 ? 'this rule' : 'these rules'}.${note ? ` ${note}` : ''}`
      : `${recent.length} postings ${daysText(J.days)}. Add a rule to see fewer.`;
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
  const tags = [salaryText(j), j.due && `Apply by ${shortDate(j.due)}`].filter(Boolean);
  return `<li><a class="jb" href="${esc(postingUrl(j.id))}" target="_blank" rel="noopener">
    <span class="jb-title">${esc(j.title)}</span>
    ${where ? `<span class="jb-meta">${esc(where)}</span>` : ''}
    ${grade || tags.length ? `<span class="jb-tags">${grade ? `<span class="jb-grade">${esc(grade)}</span>` : ''}${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</span>` : ''}
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

let card = null; // what the card last drew: { S, data, meta }

async function render() {
  const { S, data, meta } = card;
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
  const details = await loadDetails();
  const all = withDetails(data.jobs, details);
  const jobs = pick(all, J);
  // Rules about details leave out postings whose pages haven't been read.
  const note = unreadText(unread(pick(all, J, { rules: false }), data, J, details));
  $('#jobs-count').textContent = jobs.length || '';
  paintLinks(jobs.length);
  body.innerHTML = `${
    jobs.length ? list(jobs.slice(0, SHOWN)) : `<p class="quiet${note ? '' : ' is-empty'}">No new postings${rules ? ' pass your rules' : ''} ${esc(daysText(J.days))}.</p>`
  }${note ? `<p class="quiet jb-note">${esc(note)}</p>` : ''}`;
}

let watching = false;
export function refreshJobs(S, force = false) {
  if (!watching) onDetails(() => card && render());
  watching = true;
  loadJobs(force, (data, meta) => {
    card = { S, data, meta };
    render();
    if (data) ensureDetails(pick(data.jobs, S.jobs, { rules: false }).map((j) => j.id));
  });
}
