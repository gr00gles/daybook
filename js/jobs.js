// New vacancies from StateJobsNY, New York State's jobs site: the jobs open to the general
// public, newest first, grouped by the day they were posted. The site has no API or public
// feed; its vacancy page carries the whole list as one HTML table, which is read here by the
// column headings, so a column moving doesn't break it. Salary and the other details are on
// each posting's own page, which is read once per posting. Every column and detail is kept, so
// the rules in Settings can use any field the site lists. Rules filter the list as it's drawn,
// so changing them doesn't refetch. The card shows the newest few; jobs.html lists them all.
import { $, esc, cached, local, updatedText, errorText, addDays } from './util.js';
import { icon } from './icons.js';
import { setTicker } from './ticker.js';

const SITE = 'https://statejobs.ny.gov/public/';
export const LIST = `${SITE}vacancyTable.cfm`;
const KEEP = 14; // days of postings kept; Settings offers up to this many
const SHOWN = 8;

// When they were posted: [days back, label in Settings, words for a sentence]. -1 is the site's
// Yesterday's Postings, and 0 its Date From and Date To.
export const JOB_DAYS = [
  [1, 'Today’s postings', 'today'],
  [-1, 'Yesterday’s postings', 'yesterday'],
  [2, 'Today and yesterday', 'since yesterday'],
  [3, 'The last 3 days', 'in the last 3 days'],
  [7, 'The last week', 'in the last week'],
  [14, 'The last two weeks', 'in the last two weeks'],
  [0, 'Between two dates', ''],
];

// The first and last day (YYYY-MM-DD) postings are shown from.
export function windowOf(J) {
  const day = (n) => isoDay(addDays(Date.now(), n));
  if (J.days === 0) return [J.from || day(-KEEP), J.to || day(0)];
  if (J.days === -1) return [day(-1), day(-1)];
  return [day(1 - J.days), day(0)];
}

export function whenText(J) {
  if (J.days !== 0) return JOB_DAYS.find(([d]) => d === J.days)?.[2] || `in the last ${J.days} days`;
  const [from, to] = windowOf(J);
  return from === to ? `on ${shortDate(from)}` : `posted ${shortDate(from)} to ${shortDate(to)}`;
}

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

export function salaryLabel(info) {
  const labels = Object.keys(info || {});
  return labels.find((l) => /salary range/i.test(l)) || labels.find((l) => /salary/i.test(l) && !/grade/i.test(l));
}

// Fields on a posting's page, found by what their labels say.
const DETAIL = {
  employment: /employment type/i,
  jclass: /jurisdiction/i,
  category: /occupational/i,
  county: /^county$/i,
  flextime: /flex/i,
  compressed: /compress/i,
  telecommuting: /telecommut/i,
  helps: /ny ?helps/i,
  b55: /55-?b/i,
  internship: /intern/i,
};
function detail(job, key) {
  const info = job.info || {};
  const label = key === 'salary' ? salaryLabel(info) : Object.keys(info).find((l) => DETAIL[key].test(l));
  return label ? info[label] : '';
}

// "From $55817 to $67990 Annually" as "$55,817–$67,990"; hourly pay says so.
export function salaryText(job) {
  const raw = job.info?.[salaryLabel(job.info)] || '';
  const amounts = [...raw.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  return amounts.length ? `${amounts.slice(0, 2).map(money).join('–')}${/hour/i.test(raw) ? ' an hour' : ''}` : '';
}

// Why rules may be leaving postings out: pages still to be read, pages the site wouldn't give,
// or a field none of the pages read so far has (which would mean the site changed them). Only
// options and rules about fields on the postings' pages need them.
const FIELD_WORDS = {
  salary: 'salary', employment: 'employment type', jclass: 'jurisdictional class', category: 'occupational category',
  flextime: 'flextime', compressed: 'compressed workweek', telecommuting: 'telecommuting',
};
function unread(jobs, data, J, details) {
  const onList = (f) => f === 'any' || data.columns.some((c) => c.label.toLowerCase() === f.toLowerCase());
  const needs = searchTests(J.search).map((t) => t.needs).filter(Boolean);
  if (!needs.length && !activeRules(J).some((r) => !onList(r.field))) return { waiting: 0, failed: 0, absent: [] };
  const missing = jobs.filter((j) => !j.info);
  const failed = missing.filter((j) => details[j.id]?.error).length;
  const read = jobs.filter((j) => j.info);
  const absent = read.length >= 5 ? needs.filter((k) => FIELD_WORDS[k] && read.every((j) => !detail(j, k))) : [];
  return { waiting: missing.length - failed, failed, absent: [...new Set(absent)] };
}

const unreadText = ({ waiting, failed, absent }) =>
  [
    waiting && `Reading ${waiting} more ${waiting === 1 ? 'posting' : 'postings'} for your rules…`,
    failed && `StateJobsNY wouldn’t give the ${failed === 1 ? 'page of 1 posting' : `pages of ${failed} postings`}, so your rules leave ${failed === 1 ? 'it' : 'them'} out for now.`,
    absent.length && `Daybook couldn’t find the ${absent.map((k) => FIELD_WORDS[k]).join(' or ')} on the postings’ pages, so ${absent.length === 1 ? 'that option leaves' : 'those options leave'} them all out. StateJobsNY may have changed its pages.`,
  ]
    .filter(Boolean)
    .join(' ');

// ---- The site's search ----------------------------------------------------------------
// Settings → NYS jobs has every option of StateJobsNY's own search (public/search.cfm), applied
// here to the postings Daybook has read, along with any rules of your own.

export const CATEGORIES = [
  'Clerical, Secretarial, Office Aide', 'Financial, Accounting, Auditing', 'Education, Teaching', 'Skilled Craft, Apprenticeship, Maintenance',
  'Health Care, Human/Social Services', 'I.T. Engineering, Sciences', 'Administrative or General Management', 'Enforcement or Protective Services',
  'Legal', 'Other Professional Careers',
];

// The site's regions and their counties, from its region map (assets/help/regionMapText.cfm).
export const REGIONS = {
  'Capital/Saratoga': ['Albany', 'Columbia', 'Fulton', 'Greene', 'Montgomery', 'Rensselaer', 'Saratoga', 'Schenectady', 'Schoharie', 'Warren', 'Washington'],
  'Eastern Adirondacks': ['Clinton', 'Essex', 'Franklin', 'Hamilton'],
  'Western Adirondacks': ['Herkimer', 'Jefferson', 'Lewis', 'Oneida', 'Oswego', 'St. Lawrence'],
  'Central New York': ['Broome', 'Cayuga', 'Chenango', 'Cortland', 'Madison', 'Onondaga', 'Otsego', 'Tioga', 'Tompkins'],
  'Finger Lakes': ['Chemung', 'Genesee', 'Livingston', 'Monroe', 'Ontario', 'Schuyler', 'Seneca', 'Steuben', 'Wayne', 'Yates'],
  'Western New York': ['Allegany', 'Cattaraugus', 'Chautauqua', 'Erie', 'Niagara', 'Orleans', 'Wyoming'],
  'Hudson Valley': ['Delaware', 'Dutchess', 'Orange', 'Putnam', 'Sullivan', 'Ulster'],
  'Westchester/Rockland': ['Rockland', 'Westchester'],
  'Long Island': ['Nassau', 'Suffolk'],
  'New York City': ['Bronx', 'Kings', 'New York', 'Queens', 'Richmond'],
  'Region Not Provided': [],
  'Outside NY': [],
};
const BOROUGHS = { manhattan: 'new york', brooklyn: 'kings', 'staten island': 'richmond', 'saint lawrence': 'st. lawrence', 'st lawrence': 'st. lawrence' };
const REGION_OF = new Map(Object.entries(REGIONS).flatMap(([r, counties]) => counties.map((c) => [c.toLowerCase(), r])));

// The regions a posting's county (or counties) are in.
export function regionsOf(county) {
  const parts = String(county || '')
    .split(/[,;/]|\band\b/)
    .map((c) => norm(c))
    .filter(Boolean);
  if (!parts.length) return ['Region Not Provided'];
  return [...new Set(parts.map((c) => REGION_OF.get(BOROUGHS[c] || c) || (/outside|out of state/.test(c) ? 'Outside NY' : 'Region Not Provided')))];
}

export const FLEX = { flextime: 'Flextime Allowed', compressed: 'Compressed Workweek Allowed', telecommuting: 'Telecommuting Allowed' };
export const YES_NO = { helps: 'NY HELPS', b55: '55-b/c Eligible', internship: 'Internship' };
export const GRADE_OPS = { gt: 'Greater Than', lt: 'Less Than', eq: 'Equal To' };
// Values the site's lists start with; the postings' own are added as their pages are read.
export const CLASSES = ['Competitive Class', 'Non-competitive Class', 'Exempt Class', 'Labor Class'];
export const EMPLOYMENT = ['Full-Time', 'Part-Time'];

const same = (a, b) => norm(a).replace(/[^a-z0-9]/g, '') === norm(b).replace(/[^a-z0-9]/g, '');

// NY HELPS, 55-b/c and internships: a Yes or No on the posting's page when it has one, or else
// whether the posting mentions it anywhere.
const MENTION = { helps: /ny ?helps/i, b55: /55-?[bc]\b/i, internship: /\bintern(ship)?s?\b/i };
function yes(job, key) {
  const v = detail(job, key);
  if (/^(yes|no)\b/i.test(v)) return /^y/i.test(v);
  return MENTION[key].test([job.title, ...Object.values(job.cells || {}), ...Object.values(job.info || {})].join(' '));
}

// Each option that's set, as a test of a posting; `needs` names a field from the posting's page.
export function searchTests(s = {}) {
  const tests = [];
  const words = norm(s.keyword).split(' ').filter(Boolean);
  if (words.length) {
    tests.push({
      test: (j) => {
        const text = fieldText(j, 'any').join(' ');
        return words.every((w) => text.includes(w));
      },
    });
  }
  if (norm(s.title)) tests.push({ test: (j) => norm(j.title).includes(norm(s.title)) });
  if (s.jclass) tests.push({ needs: 'jclass', test: (j) => same(detail(j, 'jclass'), s.jclass) });
  if (s.agency) tests.push({ test: (j) => same(j.agency, s.agency) });
  for (const k of Object.keys(YES_NO)) if (s[k]) tests.push({ needs: 'page', test: (j) => yes(j, k) === (s[k] === 'yes') });
  for (const k of s.flex || []) if (FLEX[k]) tests.push({ needs: k, test: (j) => /^y/i.test(detail(j, k)) });
  if (s.categories?.length) tests.push({ needs: 'category', test: (j) => s.categories.some((c) => same(detail(j, 'category'), c)) });
  if (s.regions?.length) tests.push({ test: (j) => regionsOf(j.county || detail(j, 'county')).some((r) => s.regions.includes(r)) });
  if (s.employment) tests.push({ needs: 'employment', test: (j) => same(detail(j, 'employment'), s.employment) });
  const grade = numberIn(s.grade);
  if (!Number.isNaN(grade)) {
    tests.push({
      test: (j) => {
        const n = numberIn(j.grade);
        return !Number.isNaN(n) && { gt: n > grade, lt: n < grade, eq: n === grade }[s.gradeOp || 'gt'];
      },
    });
  }
  // A salary compares where its range starts: what new State hires are paid.
  const salary = numberIn(s.salary);
  if (!Number.isNaN(salary)) tests.push({ needs: 'salary', test: (j) => numberIn(detail(j, 'salary')) >= salary });
  return tests;
}

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

// The postings from the days Settings asks for, and with `rules`, only those matching every
// option of the search and passing every rule.
export function pick(jobs, J, { rules = true } = {}) {
  const [from, to] = windowOf(J);
  const tests = rules ? [...searchTests(J.search), ...activeRules(J).map((r) => ({ test: (j) => passes(j, r) }))] : [];
  return jobs.filter((j) => j.posted >= from && j.posted <= to && tests.every((t) => t.test(j)));
}

// How many options and rules are narrowing the list.
export const ruleCount = (J) => searchTests(J.search).length + activeRules(J).length;

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

// The NYS jobs part of Settings: the options of StateJobsNY's own search, in its order, then
// rules of your own, with how many of the postings Daybook has match them all.
export async function mountJobs(el, draft, changed) {
  const J = draft.jobs;
  const s = J.search;
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
  const option = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  const select = (key, any, options) =>
    `<select data-s="${key}">${option('', any, s[key])}${options.map((o) => (Array.isArray(o) ? option(o[0], o[1], s[key]) : option(o, o, s[key]))).join('')}</select>`;
  const field = (label, control) => `<label class="field"><span>${label}</span>${control}</label>`;
  const text = (key, placeholder) => `<input type="text" data-s="${key}" value="${esc(s[key])}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">`;
  const boxes = (key, list, title = () => '') =>
    list
      .map(([value, label]) => `<label class="check"${title(value) ? ` title="${esc(title(value))}"` : ''}><input type="checkbox" data-s-list="${key}" value="${esc(value)}"${s[key].includes(value) ? ' checked' : ''}><span>${esc(label)}</span></label>`)
      .join('');
  // The site's choices, then any others the postings' pages have used.
  const choices = (start, key) => {
    const seen = new Map(start.map((v) => [norm(v), v]));
    for (const j of jobs) {
      const v = detail(j, key);
      if (v && !seen.has(norm(v))) seen.set(norm(v), v);
    }
    return [...seen.values()];
  };
  const agencies = [...new Map(jobs.filter((j) => j.agency).map((j) => [j.agency, agencyName(j.agency)]))].sort((a, b) => a[1].localeCompare(b[1]));
  if (s.agency && !agencies.some(([a]) => a === s.agency)) agencies.unshift([s.agency, agencyName(s.agency)]);

  const paintCount = () => {
    const box = el.querySelector('.jr-count');
    if (!data?.jobs) {
      box.textContent = 'Once the card has loaded the postings, this shows how many match.';
      return;
    }
    const recent = pick(jobs, J, { rules: false });
    const kept = pick(jobs, J).length;
    const note = unreadText(unread(recent, data, J, details));
    box.textContent = ruleCount(J)
      ? `${kept} of the ${recent.length} postings ${whenText(J)} match.${note ? ` ${note}` : ''}`
      : `${recent.length} postings ${whenText(J)}. Set an option or add a rule to see fewer.`;
  };

  const paint = () => {
    el.innerHTML = `<h4>Search for vacancies</h4>
      <div class="grid2">
        ${field('Containing the keyword', text('keyword', 'Any word in the posting'))}
        ${field('With the title', text('title', 'analyst'))}
        ${field('In the jurisdictional class', select('jclass', 'Any jurisdictional class', choices(CLASSES, 'jclass')))}
        ${field('In which NYS agency', select('agency', 'Any agency', agencies))}
        ${Object.entries(YES_NO).map(([k, label]) => field(label, select(k, '--', [['yes', 'Yes'], ['no', 'No']]))).join('')}
      </div>
      <h4>Restrict by date posted</h4>
      <div class="grid2">
        ${field('Posted', `<select data-r-days>${JOB_DAYS.map(([n, l]) => option(n, l, J.days)).join('')}</select>`)}
      </div>
      <div class="grid2 jr-dates"${J.days === 0 ? '' : ' hidden'}>
        ${field('Date from', `<input type="date" data-r-date="from" value="${esc(J.from)}">`)}
        ${field('Date to', `<input type="date" data-r-date="to" value="${esc(J.to)}">`)}
      </div>
      <h4>Flexibility in the workplace</h4>
      <div class="topics">${boxes('flex', Object.entries(FLEX))}</div>
      <h4>Include occupational categories</h4>
      <div class="topics wide">${boxes('categories', choices(CATEGORIES, 'category').map((c) => [c, c]))}</div>
      <h4>Include regions</h4>
      <div class="topics">${boxes('regions', Object.keys(REGIONS).map((r) => [r, r]), (r) => REGIONS[r].join(', '))}</div>
      <h4>Other requirements</h4>
      <div class="grid2">
        ${field('Employment type', select('employment', 'Full/Part Time', choices(EMPLOYMENT, 'employment')))}
        <div class="field"><span>Salary grade</span><div class="jr-pair">
          <select data-s="gradeOp" aria-label="Compare the grade">${Object.entries(GRADE_OPS).map(([k, l]) => option(k, l, s.gradeOp)).join('')}</select>
          <select data-s="grade" aria-label="Grade level">${option('', 'Any grade level', s.grade)}${Array.from({ length: 38 }, (_, i) => option(i + 1, `Grade ${i + 1}`, s.grade)).join('')}</select>
        </div></div>
        ${field('Minimum salary', `<input type="text" inputmode="numeric" data-s="salary" value="${esc(s.salary)}" placeholder="60000" autocomplete="off">`)}
      </div>
      <p class="hint">Ticking nothing in a list includes all of it. A salary compares where its range starts, which is what new State hires are paid.</p>
      <h4>More rules</h4>
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
    if (t.matches('[data-r-days]')) {
      J.days = Number(t.value);
      el.querySelector('.jr-dates').hidden = J.days !== 0;
    } else if (t.dataset.rDate) J[t.dataset.rDate] = t.value;
    else if (t.dataset.s) s[t.dataset.s] = t.value.trim();
    else if (t.dataset.sList) {
      const set = new Set(s[t.dataset.sList]);
      if (t.checked) set.add(t.value);
      else set.delete(t.value);
      s[t.dataset.sList] = [...set];
    } else if (t.dataset.r) J.rules[Number(t.dataset.r)][t.dataset.k] = t.value;
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
  const rules = ruleCount(J);
  $('#jobs-updated').textContent = meta.error && data ? "couldn't refresh" : data ? updatedText(meta.at) : '';
  $('#jobs-filter').textContent = rules ? `${rules} ${rules === 1 ? 'rule' : 'rules'}` : '';
  if (!data) {
    setTicker('jobs', []);
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
  setTicker(
    'jobs',
    jobs.map((j) => ({ tag: dayLabel(j.posted), title: j.title, meta: salaryText(j) || agencyName(j.agency), href: postingUrl(j.id), newTab: true })),
  );
  body.innerHTML = `${
    jobs.length ? list(jobs.slice(0, SHOWN)) : `<p class="quiet${note ? '' : ' is-empty'}">No new postings${rules ? ' match your rules' : ''} ${esc(whenText(J))}.</p>`
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
