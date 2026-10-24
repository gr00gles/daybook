// The Companies page: one page per company you deal with, with what you need when you call or
// log in (phone, account number, people, hours, notes, links), a summary from Wikipedia, and
// the unread email and deliveries Daybook has seen from them. Edits save as you type.
import { $, $$, esc, local, relTime, safeUrl, getJSON, showToast, errorText } from './util.js';
import { loadSettings } from './settings.js';
import { icon } from './icons.js';
import { deliveriesFrom, deliveryRows, initDeliveries } from './packages.js';
import {
  listCompanies, saveCompany, removeCompany, isCompanyKey, newCompany, companyDomains, domainOf, webUrl, logoUrl, fromCompany, PERSONAL_MAIL,
} from './companies-store.js';

const S = await loadSettings();
if (S.theme !== 'system') document.documentElement.dataset.theme = S.theme;
$('#co-back').insertAdjacentHTML('afterbegin', icon('chevron-left'));
$('#co-add').insertAdjacentHTML('afterbegin', icon('plus'));
initDeliveries();

let companies = [];
let current = null; // the company on screen
let mail = []; // every email Daybook has kept on this computer, newest first
let saveTimer;
let pending = false;

// ---- Mail Daybook already has ----------------------------------------------------------------
// The new tab keeps the latest unread mail and shipping emails in local storage. Nothing new is
// fetched here.

async function loadMail() {
  const all = await chrome.storage.local.get(null);
  const items = [];
  for (const [key, v] of Object.entries(all)) {
    if (!/^cache:(?:gmail:|outlook-mail$|pkg:mail$)/.test(key) || !v?.data) continue;
    const list = Array.isArray(v.data) ? v.data : v.data.items || [];
    // Shipping emails are read or not; the unread feeds' are all unread.
    for (const m of list) items.push({ ...m, unread: key === 'cache:pkg:mail' ? Boolean(m.unread) : true });
  }
  // The same email can be in the unread feed and among the shipping emails.
  const byId = new Map();
  for (const m of items) {
    const id = m.msgId || m.id || `${m.subject}|${m.at}`;
    const had = byId.get(id);
    byId.set(id, had ? { ...had, ...m, unread: had.unread || m.unread } : m);
  }
  mail = [...byId.values()].sort((a, b) => b.at - a.at);
}

// Companies you get email from and haven't added: the most frequent senders' domains.
function suggestions() {
  const have = new Set(companies.flatMap((c) => [...companyDomains(c)]));
  const names = new Set(companies.map((c) => c.name.trim().toLowerCase()));
  const by = new Map();
  for (const m of mail) {
    const d = domainOf(m.fromAddr);
    if (!d || PERSONAL_MAIL.has(d) || have.has(d)) continue;
    if (!by.has(d)) by.set(d, { domain: d, n: 0, names: new Map() });
    const e = by.get(d);
    e.n++;
    if (m.from && !m.from.includes('@')) e.names.set(m.from, (e.names.get(m.from) || 0) + 1);
  }
  return [...by.values()]
    .map((e) => {
      const base = e.domain.split('.')[0];
      const name = [...e.names].sort((a, b) => b[1] - a[1]).map(([n]) => n).find((n) => n.length <= 30 && n.toLowerCase().replace(/[^a-z0-9]/g, '').includes(base.replace(/[^a-z0-9]/g, '')));
      return { ...e, name: name || base.charAt(0).toUpperCase() + base.slice(1) };
    })
    .filter((e) => !names.has(e.name.toLowerCase()))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
}

// ---- The list ------------------------------------------------------------------------------

const logo = (c, size = 'small') => {
  const src = logoUrl(domainOf(webUrl(c.website)) || domainOf(c.email), 64);
  return src
    ? `<span class="co-logo ${size}"><img src="${esc(src)}" alt="" referrerpolicy="no-referrer"></span>`
    : `<span class="co-logo ${size} letter">${esc((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;
};

function paintList() {
  const q = $('#co-filter').value.trim().toLowerCase();
  const shown = companies.filter((c) => !q || `${c.name} ${c.category} ${c.website}`.toLowerCase().includes(q));
  $('#co-list').innerHTML = shown.length
    ? shown
        .map(
          (c) => `<li><a class="co-item${c.id === current?.id ? ' on' : ''}" href="#${esc(c.id)}"${c.id === current?.id ? ' aria-current="page"' : ''}>
          ${logo(c)}<span class="co-item-text"><span class="co-item-name">${esc(c.name || 'Untitled')}</span>${c.category ? `<span class="co-item-cat">${esc(c.category)}</span>` : ''}</span></a></li>`,
        )
        .join('')
    : companies.length
      ? '<li class="quiet">No company matches.</li>'
      : '';
  const ideas = suggestions();
  $('#co-suggest').hidden = !ideas.length;
  $('#co-suggest-list').innerHTML = ideas
    .map(
      (e) => `<button type="button" class="chip co-idea" data-domain="${esc(e.domain)}" data-name="${esc(e.name)}" title="${e.n} ${e.n === 1 ? 'email' : 'emails'} from ${esc(e.domain)}">${icon('plus')}${esc(e.name)}</button>`,
    )
    .join('');
}

// ---- One company -----------------------------------------------------------------------------

const FACTS = [
  { f: 'website', label: 'Website', type: 'url', placeholder: 'lowes.com' },
  { f: 'phone', label: 'Phone', type: 'tel', placeholder: '1-800-…' },
  { f: 'email', label: 'Email', type: 'email', placeholder: 'help@…' },
  { f: 'account', label: 'Account or member number', type: 'text', placeholder: '' },
  { f: 'address', label: 'Address', type: 'text', placeholder: 'Street, town' },
  { f: 'hours', label: 'Hours', type: 'text', placeholder: 'Mon–Fri 8–6' },
];

function actions(c) {
  const out = [];
  const site = webUrl(c.website);
  if (site) out.push(`<a class="btn small" href="${esc(site)}">${icon('globe')}Website</a>`);
  const tel = c.phone.replace(/[^\d+]/g, '');
  if (tel.length >= 3) out.push(`<a class="btn small" href="tel:${esc(tel)}">${icon('phone')}Call</a>`);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) out.push(`<a class="btn small" href="mailto:${esc(c.email.trim())}">${icon('mail')}Email</a>`);
  if (c.address.trim()) out.push(`<a class="btn small" href="https://www.google.com/maps/search/${encodeURIComponent(c.address.trim())}">${icon('pin')}Directions</a>`);
  return out.join('');
}

function aboutHtml(c) {
  const a = c.about;
  if (a?.extract)
    return `<p class="co-about-text">${esc(a.extract)}</p>
      <p class="co-about-foot"><a href="${esc(safeUrl(a.url))}">${icon('external')}${esc(a.title)} on Wikipedia</a>
      <button class="btn small ghost" type="button" data-co="wiki">${icon('refresh')}Look again</button>
      <button class="btn small ghost" type="button" data-co="wiki-clear">Remove</button></p>`;
  return `<p class="quiet">Fill this in with a short summary from Wikipedia. Only the company name is sent.</p>
    <button class="btn small" type="button" data-co="wiki"${c.name.trim() ? '' : ' disabled'}>${icon('search')}Look up ${esc(c.name.trim() || 'the company')} on Wikipedia</button>`;
}

const linkRow = (l, i) => `<div class="co-link-row" data-i="${i}">
  <label class="field narrow"><span>Label</span><input type="text" data-link="label" value="${esc(l.label)}" placeholder="Pay bill" autocomplete="off"></label>
  <label class="field"><span>Web address</span><input type="url" data-link="url" value="${esc(l.url)}" placeholder="https://…" spellcheck="false" autocomplete="off"></label>
  ${webUrl(l.url) ? `<a class="icon-btn" href="${esc(webUrl(l.url))}" aria-label="Open ${esc(l.label || 'link')}">${icon('external')}</a>` : ''}
  <button class="icon-btn" type="button" data-co="remove-link" aria-label="Remove link">${icon('close')}</button>
</div>`;

function mailHtml(c) {
  const domains = companyDomains(c);
  const theirs = mail.filter((m) => fromCompany(c, m, domains));
  const unread = theirs.filter((m) => m.unread);
  const pkgs = deliveriesFrom(mail).filter((d) => (d.domain && domains.has(d.domain)) || fromCompany(c, d, domains));
  const rows = theirs
    .slice(0, 8)
    .map(
      (m) => `<li><a class="co-mail" href="${esc(safeUrl(m.url))}">
        <span class="co-mail-from">${m.unread ? '<span class="co-unread" title="Unread"></span>' : ''}${esc(m.from)}</span><time datetime="${new Date(m.at).toISOString()}">${relTime(m.at)}</time>
        <span class="co-mail-subject">${esc(m.subject)}</span></a></li>`,
    )
    .join('');
  return {
    mail: rows
      ? `<ol class="co-mail-list">${rows}</ol>`
      : `<p class="quiet">${domains.size || c.name.trim() ? 'Nothing from them in the mail Daybook has seen lately.' : 'Add their website or email address and their emails show up here.'}</p>`,
    count: unread.length,
    deliveries: pkgs.length ? deliveryRows(pkgs, 5) : '<p class="quiet">No deliveries from them right now.</p>',
  };
}

function paintMain() {
  const main = $('#co-main');
  const c = current;
  if (!c) {
    main.innerHTML = `<div class="co-empty">
      <span class="co-empty-icon">${icon('building')}</span>
      <h2>${companies.length ? 'Pick a company' : 'A page for each company you deal with'}</h2>
      <p>Keep the phone number, your account number, the people you talk to and notes from your calls in one place. Emails and deliveries from them show up on their page.</p>
      <button class="btn primary" type="button" data-co="add">${icon('plus')}Add a company</button>
    </div>`;
    return;
  }
  const m = mailHtml(c);
  main.innerHTML = `<article class="co-page" data-id="${esc(c.id)}">
    <header class="co-hero">
      <span id="co-hero-logo">${logo(c, 'big')}</span>
      <div class="co-names">
        <input class="co-name" data-f="name" value="${esc(c.name)}" placeholder="Company name" aria-label="Company name" autocomplete="off">
        <input class="co-cat" data-f="category" value="${esc(c.category)}" placeholder="What they are to you: bank, utility, insurance, contractor…" aria-label="Kind of company" autocomplete="off">
      </div>
      <div class="co-actions" id="co-actions">${actions(c)}</div>
    </header>
    <div class="co-grid">
      <div class="co-col">
        <section class="card co-card" aria-labelledby="co-about-h">
          <header class="card-head"><h2 id="co-about-h">About</h2></header>
          <div id="co-about">${aboutHtml(c)}</div>
        </section>
        <section class="card co-card" aria-labelledby="co-facts-h">
          <header class="card-head"><h2 id="co-facts-h">Details</h2></header>
          <div class="grid2 co-facts">
            ${FACTS.map(
              (x) => `<label class="field"><span>${x.label}</span><input type="${x.type}" data-f="${x.f}" value="${esc(c[x.f])}" placeholder="${esc(x.placeholder)}" autocomplete="off" spellcheck="false"></label>`,
            ).join('')}
          </div>
          <label class="field co-domains"><span>They also email from (domains, separated by commas)</span><input type="text" data-f="domains" value="${esc(c.domains)}" placeholder="example-mail.com" autocomplete="off" spellcheck="false"></label>
        </section>
        <section class="card co-card" aria-labelledby="co-notes-h">
          <header class="card-head"><h2 id="co-notes-h">Notes</h2><span class="stamp" id="co-saved"></span></header>
          <label class="field"><span>People</span><textarea class="co-text" data-f="people" rows="3" maxlength="1500" placeholder="Who you talk to there, and how to reach them">${esc(c.people)}</textarea></label>
          <label class="field"><span>Notes</span><textarea class="co-text" data-f="notes" rows="7" maxlength="4000" placeholder="Policy numbers, what was said on the last call, when the contract ends…">${esc(c.notes)}</textarea></label>
        </section>
        <section class="card co-card" aria-labelledby="co-links-h">
          <header class="card-head"><h2 id="co-links-h">Links</h2></header>
          <div id="co-links">${c.links.map(linkRow).join('')}</div>
          <button class="btn small" type="button" data-co="add-link">${icon('plus')}Add a link</button>
        </section>
      </div>
      <div class="co-col">
        <section class="card co-card" aria-labelledby="co-mail-h">
          <header class="card-head"><h2 id="co-mail-h">Email from them <span class="head-count" id="co-mail-count" title="Unread">${m.count || ''}</span></h2></header>
          <div id="co-mail">${m.mail}</div>
        </section>
        <section class="card co-card" aria-labelledby="co-pkg-h">
          <header class="card-head"><h2 id="co-pkg-h">Deliveries</h2></header>
          <div id="co-pkg">${m.deliveries}</div>
        </section>
        <button class="btn small co-delete" type="button" data-co="delete">${icon('trash')}Delete this company</button>
      </div>
    </div>
  </article>`;
}

function show(id) {
  flush();
  current = companies.find((c) => c.id === id) || null;
  document.title = current ? `${current.name || 'Untitled'} · Companies` : 'Companies';
  paintList();
  paintMain();
}

// ---- Saving ------------------------------------------------------------------------------------

function queueSave() {
  pending = true;
  $('#co-saved') && ($('#co-saved').textContent = '');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!pending || !current) return;
  pending = false;
  const c = current;
  try {
    await saveCompany(c);
    if ($('#co-saved') && current === c) $('#co-saved').textContent = 'saved';
  } catch (err) {
    showToast(/quota/i.test(err.message) ? 'Chrome sync is full. Shorten some notes or delete a company you no longer need.' : `Couldn’t save: ${errorText(err)}`);
  }
}

// The parts of the page that follow a field.
function followEdit(field) {
  const c = current;
  if (['website', 'email', 'name'].includes(field)) $('#co-hero-logo').innerHTML = logo(c, 'big');
  if (['website', 'phone', 'email', 'address'].includes(field)) $('#co-actions').innerHTML = actions(c);
  if (field === 'name') {
    document.title = `${c.name || 'Untitled'} · Companies`;
    if (!c.about) $('#co-about').innerHTML = aboutHtml(c);
  }
  if (['name', 'website', 'email', 'domains'].includes(field)) {
    const m = mailHtml(c);
    $('#co-mail').innerHTML = m.mail;
    $('#co-mail-count').textContent = m.count || '';
    $('#co-pkg').innerHTML = m.deliveries;
  }
  if (['name', 'category', 'website', 'email'].includes(field)) paintList();
}

// ---- Wikipedia ---------------------------------------------------------------------------------

async function lookUp(c) {
  const box = $('#co-about');
  box.innerHTML = '<p class="quiet">Looking it up…</p>';
  try {
    const q = new URLSearchParams({ action: 'query', list: 'search', srsearch: c.name.trim(), srlimit: '5', format: 'json', origin: '*' });
    const hits = (await getJSON(`https://en.wikipedia.org/w/api.php?${q}`)).query?.search || [];
    let found = null;
    for (const h of hits.slice(0, 3)) {
      const s = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`);
      if (s.type !== 'disambiguation' && s.extract) {
        found = s;
        break;
      }
    }
    if (current !== c) return;
    if (!found) {
      box.innerHTML = `<p class="quiet">Wikipedia has no page for “${esc(c.name.trim())}”. Try the company’s full name.</p>${aboutHtml({ ...c, about: null })}`;
      return;
    }
    c.about = {
      title: found.title,
      description: found.description || '',
      extract: found.extract.slice(0, 1200),
      url: found.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(found.title)}`,
      at: Date.now(),
    };
    queueSave();
    flush();
    box.innerHTML = aboutHtml(c);
  } catch (err) {
    if (current === c) box.innerHTML = `<p class="notice warn">Couldn’t reach Wikipedia: ${esc(errorText(err))}.</p>${aboutHtml({ ...c, about: null })}`;
  }
}

// ---- Wiring ------------------------------------------------------------------------------------

async function add(name = '', website = '') {
  flush();
  const c = newCompany(name, website);
  companies.push(c);
  companies.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  await saveCompany(c);
  location.hash = c.id;
  return c;
}

$('#co-add').addEventListener('click', async () => {
  await add();
  $('.co-name')?.focus();
});
$('#co-filter').addEventListener('input', paintList);
$('#co-suggest-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.co-idea');
  if (b) await add(b.dataset.name, `https://${b.dataset.domain}/`);
});

const main = $('#co-main');
main.addEventListener('input', (e) => {
  const el = e.target;
  if (!current) return;
  if (el.dataset.f) {
    current[el.dataset.f] = el.value;
    followEdit(el.dataset.f);
  } else if (el.dataset.link) {
    current.links[Number(el.closest('.co-link-row').dataset.i)][el.dataset.link] = el.value;
  } else return;
  queueSave();
});
main.addEventListener('change', (e) => {
  const row = e.target.closest('.co-link-row');
  if (row) row.outerHTML = linkRow(current.links[Number(row.dataset.i)], Number(row.dataset.i));
});
main.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-co]');
  if (!b) return;
  const what = b.dataset.co;
  if (what === 'add') {
    await add();
    $('.co-name')?.focus();
  } else if (what === 'wiki') lookUp(current);
  else if (what === 'wiki-clear') {
    current.about = null;
    queueSave();
    $('#co-about').innerHTML = aboutHtml(current);
  } else if (what === 'add-link') {
    current.links.push({ label: '', url: '' });
    $('#co-links').insertAdjacentHTML('beforeend', linkRow(current.links.at(-1), current.links.length - 1));
    $('#co-links .co-link-row:last-child input')?.focus();
    queueSave();
  } else if (what === 'remove-link') {
    current.links.splice(Number(b.closest('.co-link-row').dataset.i), 1);
    $('#co-links').innerHTML = current.links.map(linkRow).join('');
    queueSave();
  } else if (what === 'delete') {
    const c = current;
    pending = false;
    clearTimeout(saveTimer);
    await removeCompany(c.id);
    companies = companies.filter((x) => x.id !== c.id);
    history.replaceState(null, '', location.pathname);
    show(null);
    showToast(`Deleted ${c.name || 'the company'}.`, async () => {
      await saveCompany(c);
      companies = await listCompanies();
      location.hash = c.id;
    });
  }
});

addEventListener('hashchange', () => route());
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

// Another tab or computer changed a company: pick it up unless you are typing in it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !Object.keys(changes).some(isCompanyKey)) return;
  const typing = pending || main.contains(document.activeElement);
  const fresh = await listCompanies();
  if (typing && current) {
    companies = fresh.map((c) => (c.id === current.id ? current : c));
    if (!fresh.some((c) => c.id === current.id)) companies.push(current);
    paintList();
    return;
  }
  companies = fresh;
  show(current && companies.some((c) => c.id === current.id) ? current.id : null);
});

async function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === 'new') {
    await add();
    $('.co-name')?.focus();
    return;
  }
  show(companies.some((c) => c.id === id) ? id : null);
}

companies = await listCompanies();
await loadMail();
route();
