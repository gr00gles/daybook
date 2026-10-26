// Groups of saved sites in the shortcuts row, like folders on a bookmarks bar: hover over a
// group's icon (or click it) and its sites pop out as bubbles. Groups are kept in Chrome sync
// under `siteGroups` and edited on the page. A Companies group lists your company pages.
import { $, $$, esc, showToast, zoom, rectOf } from './util.js';
import { icon, GROUP_ICONS, hasIcon } from './icons.js';
import { listCompanies, domainOf, webUrl, logoUrl } from './companies-store.js';

const KEY = 'siteGroups';

// What a new copy of Daybook starts with; edit or delete it like any other group.
const STARTER = [
  {
    id: 'g-home',
    name: 'Hardware',
    icon: 'hammer',
    sites: [
      { name: 'Lowe’s', url: 'https://www.lowes.com/' },
      { name: 'Home Depot', url: 'https://www.homedepot.com/' },
      { name: 'Tractor Supply', url: 'https://www.tractorsupply.com/' },
    ],
  },
];

export async function loadGroups() {
  const { [KEY]: groups } = await chrome.storage.sync.get(KEY);
  return Array.isArray(groups) ? groups : structuredClone(STARTER);
}
const saveGroups = (groups) => chrome.storage.sync.set({ [KEY]: groups });

const labelOf = (url) => {
  const d = domainOf(url);
  const base = d.split('.')[0] || '';
  return base.charAt(0).toUpperCase() + base.slice(1);
};

let groups = [];
let companies = [];
let onChange = () => {};

// The group tiles, as HTML for the start of the shortcuts row.
export async function groupTiles({ companies: withCompanies, changed }) {
  onChange = changed || onChange;
  groups = await loadGroups();
  companies = withCompanies ? await listCompanies() : [];
  wire();
  const tiles = groups.map(
    (g) => `<button type="button" class="shortcut group" data-group="${esc(g.id)}" aria-haspopup="true" aria-expanded="false" title="${esc(g.name)}">
      <span class="group-icon">${icon(hasIcon(g.icon) ? g.icon : 'folder')}</span><span>${esc(g.name)}</span></button>`,
  );
  if (withCompanies)
    tiles.push(`<button type="button" class="shortcut group" data-group="companies" aria-haspopup="true" aria-expanded="false" title="Your companies">
      <span class="group-icon">${icon('building')}</span><span>Companies</span></button>`);
  return tiles.join('');
}

// ---- The bubbles ------------------------------------------------------------------------

const bubble = (href, img, name, i, extra = '') =>
  `<a class="bubble" href="${esc(href)}" style="--i: ${i}" role="menuitem"${extra}>${img}<span>${esc(name)}</span></a>`;
const logoImg = (url) => {
  const src = logoUrl(domainOf(url));
  return src ? `<img src="${esc(src)}" alt="" width="28" height="28" referrerpolicy="no-referrer">` : `<span class="bubble-glyph">${icon('globe')}</span>`;
};

function bubblesHtml(id) {
  if (id === 'companies') {
    const shown = companies.slice(0, 14);
    return [
      ...shown.map((c, i) =>
        bubble(
          `companies.html#${encodeURIComponent(c.id)}`,
          webUrl(c.website) ? logoImg(c.website) : `<span class="bubble-glyph letter">${esc((c.name || '?').charAt(0).toUpperCase())}</span>`,
          c.name || 'Untitled',
          i,
        ),
      ),
      bubble('companies.html', `<span class="bubble-glyph">${icon(companies.length ? 'building' : 'plus')}</span>`, companies.length ? 'See all' : 'Add one', shown.length, ' data-more'),
    ].join('');
  }
  const g = groups.find((x) => x.id === id);
  if (!g) return '';
  return [
    ...g.sites.map((s, i) => bubble(s.url, logoImg(s.url), s.name || labelOf(s.url), i)),
    `<button type="button" class="bubble" style="--i: ${g.sites.length}" role="menuitem" data-edit-group="${esc(g.id)}" data-more><span class="bubble-glyph">${icon(g.sites.length ? 'edit' : 'plus')}</span><span>${g.sites.length ? 'Edit' : 'Add sites'}</span></button>`,
  ].join('');
}

let pop;
let openFor = null; // the tile whose bubbles are showing
let openTimer;
let closeTimer;

function place(tile) {
  const r = rectOf(tile);
  const z = zoom();
  pop.style.left = `${r.left + r.width / 2 + scrollX / z}px`;
  pop.style.top = `${r.bottom + scrollY / z + 4}px`;
  // Keep the row on screen.
  const w = pop.offsetWidth;
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 12), innerWidth / z - w - 12);
  pop.style.left = `${left + scrollX / z}px`;
}

function open(tile, { focus = false } = {}) {
  clearTimeout(closeTimer);
  if (openFor === tile) return;
  if (openFor) openFor.setAttribute('aria-expanded', 'false');
  openFor = tile;
  pop.innerHTML = bubblesHtml(tile.dataset.group);
  pop.setAttribute('aria-label', tile.title);
  pop.hidden = false;
  place(tile);
  tile.setAttribute('aria-expanded', 'true');
  // The next frame, so the bubbles start small and grow.
  pop.classList.remove('open');
  requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.add('open')));
  if (focus) $('.bubble', pop)?.focus();
}

function close({ refocus = false } = {}) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (!openFor) return;
  const tile = openFor;
  openFor = null;
  tile.setAttribute('aria-expanded', 'false');
  pop.classList.remove('open');
  pop.hidden = true;
  if (refocus) tile.focus();
}

const closeSoon = () => {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => close(), 260);
};

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  pop = document.createElement('div');
  pop.className = 'bubbles';
  pop.id = 'bubbles';
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  document.body.append(pop);
  const row = $('#shortcuts');

  row.addEventListener('pointerover', (e) => {
    const tile = e.target.closest('[data-group]');
    if (!tile || e.pointerType === 'touch') return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(tile), openFor ? 0 : 90);
  });
  row.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-group]') && !e.relatedTarget?.closest?.('[data-group], .bubbles')) closeSoon();
  });
  row.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-group]');
    if (!tile) return;
    if (openFor === tile && e.detail) return; // a mouse click on a tile that hover already opened
    if (openFor === tile) close();
    else open(tile, { focus: !e.detail }); // from the keyboard, move into the bubbles
  });
  row.addEventListener('keydown', (e) => {
    const tile = e.target.closest('[data-group]');
    if (tile && e.key === 'ArrowDown') {
      e.preventDefault();
      open(tile, { focus: true });
      $('.bubble', pop)?.focus();
    }
  });
  pop.addEventListener('pointerover', () => clearTimeout(closeTimer));
  pop.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget?.closest?.('.bubbles, [data-group]')) closeSoon();
  });
  pop.addEventListener('keydown', (e) => {
    const items = $$('.bubble', pop);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close({ refocus: true });
    } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key) && i >= 0) {
      e.preventDefault();
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    }
  });
  pop.addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !pop.contains(e.relatedTarget)) {
      if (e.relatedTarget !== openFor) close();
    }
  });
  pop.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-group]');
    if (edit) {
      const id = edit.dataset.editGroup;
      close();
      openGroupEditor(id);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (openFor && !e.target.closest('.bubbles, [data-group]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openFor && !pop.contains(document.activeElement)) close();
  });
  addEventListener('resize', () => openFor && place(openFor));
}

// ---- Editing a group ----------------------------------------------------------------------

let editing = null; // a copy of the group being edited
let editingNew = false;
let afterEdit = () => {};

function dialog() {
  let dlg = $('#group-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'group-dialog';
    dlg.className = 'event-dialog group-dialog';
    dlg.setAttribute('aria-labelledby', 'gd-h');
    document.body.append(dlg);
    wireDialog(dlg);
  }
  return dlg;
}

function siteRow(s, i) {
  return `<div class="gd-site" data-i="${i}">
    <span class="gd-logo">${logoImg(s.url)}</span>
    <label class="field"><span>Name</span><input type="text" data-site-field="name" value="${esc(s.name)}" placeholder="${esc(labelOf(s.url) || 'Name')}" autocomplete="off"></label>
    <label class="field"><span>Web address</span><input type="url" data-site-field="url" value="${esc(s.url)}" placeholder="lowes.com" spellcheck="false" autocomplete="off"></label>
    <button class="icon-btn" type="button" data-gd="remove-site" aria-label="Remove ${esc(s.name || 'site')}">${icon('close')}</button>
  </div>`;
}

function editorHtml() {
  const g = editing;
  return `<form class="ev-form" id="gd-form" novalidate>
    <header class="ev-form-head">
      <h2 id="gd-h">${editingNew ? 'New group' : 'Edit group'}</h2>
      <button class="icon-btn" type="button" data-gd="cancel" aria-label="Close">${icon('close')}</button>
    </header>
    <label class="field"><span>Group name</span><input id="gd-name" type="text" value="${esc(g.name)}" placeholder="Home improvement" autocomplete="off" required></label>
    <fieldset class="gd-icons">
      <legend>Icon</legend>
      ${GROUP_ICONS.map(
        (n) => `<label class="gd-icon" title="${esc(n)}"><input type="radio" name="gd-icon" value="${n}"${g.icon === n ? ' checked' : ''}><span>${icon(n)}</span></label>`,
      ).join('')}
    </fieldset>
    <div class="gd-sites" id="gd-sites">${g.sites.map(siteRow).join('')}</div>
    <button class="btn small gd-add" type="button" data-gd="add-site">${icon('plus')}Add a site</button>
    <p class="ev-error" id="gd-error" hidden></p>
    <footer class="ev-form-foot">
      ${editingNew ? '' : `<button class="btn small gd-delete" type="button" data-gd="delete">${icon('trash')}Delete group</button>`}
      <button class="btn" type="button" data-gd="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </footer>
  </form>`;
}

// Opens the editor for a group, or for a new one with no id. `done` runs after a save.
export async function openGroupEditor(id, done) {
  if (!groups.length) groups = await loadGroups();
  const g = id && groups.find((x) => x.id === id);
  editingNew = !g;
  editing = g ? structuredClone(g) : { id: `g${Date.now().toString(36)}`, name: '', icon: 'folder', sites: [{ name: '', url: '' }] };
  afterEdit = done || (() => {});
  const dlg = dialog();
  dlg.innerHTML = editorHtml();
  dlg.showModal();
  $(editingNew ? '#gd-name' : '.gd-site:last-child [data-site-field="url"]', dlg)?.focus();
}

function wireDialog(dlg) {
  dlg.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'gd-name') editing.name = el.value;
    else if (el.name === 'gd-icon') editing.icon = el.value;
    else if (el.dataset.siteField) {
      const i = Number(el.closest('.gd-site').dataset.i);
      editing.sites[i][el.dataset.siteField] = el.value;
    }
  });
  dlg.addEventListener('change', (e) => {
    const el = e.target;
    if (el.name === 'gd-icon') editing.icon = el.value;
    // Show the site's logo and suggest a name once the address is in.
    if (el.dataset.siteField === 'url') {
      const row = el.closest('.gd-site');
      const s = editing.sites[Number(row.dataset.i)];
      $('.gd-logo', row).innerHTML = logoImg(webUrl(s.url));
      $('[data-site-field="name"]', row).placeholder = labelOf(webUrl(s.url)) || 'Name';
    }
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) return dlg.close();
    const b = e.target.closest('[data-gd]');
    if (!b) return;
    const what = b.dataset.gd;
    if (what === 'cancel') dlg.close();
    else if (what === 'add-site') {
      editing.sites.push({ name: '', url: '' });
      $('#gd-sites', dlg).insertAdjacentHTML('beforeend', siteRow(editing.sites.at(-1), editing.sites.length - 1));
      $('.gd-site:last-child [data-site-field="url"]', dlg).focus();
    } else if (what === 'remove-site') {
      editing.sites.splice(Number(b.closest('.gd-site').dataset.i), 1);
      $('#gd-sites', dlg).innerHTML = editing.sites.map(siteRow).join('');
    } else if (what === 'delete') {
      const before = structuredClone(groups);
      const name = editing.name || 'the group';
      groups = groups.filter((x) => x.id !== editing.id);
      await saveGroups(groups);
      dlg.close();
      changed();
      showToast(`Deleted ${name}.`, async () => {
        groups = before;
        await saveGroups(groups);
        changed();
      });
    }
  });
  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#gd-error', dlg);
    const sites = [];
    for (const s of editing.sites) {
      if (!s.url.trim() && !s.name.trim()) continue;
      const url = webUrl(s.url);
      if (!url) {
        err.textContent = `“${s.url || s.name}” isn’t a web address. Try something like lowes.com.`;
        err.hidden = false;
        return;
      }
      sites.push({ name: s.name.trim() || labelOf(url), url });
    }
    const g = { ...editing, name: editing.name.trim() || 'Sites', sites };
    const i = groups.findIndex((x) => x.id === g.id);
    if (i >= 0) groups[i] = g;
    else groups.push(g);
    try {
      await saveGroups(groups);
    } catch (error) {
      err.textContent = `Couldn’t save: ${error.message}`;
      err.hidden = false;
      return;
    }
    dlg.close();
    changed();
  });
}

function changed() {
  onChange();
  afterEdit();
}

export const groupList = async () => (groups.length ? groups : (groups = await loadGroups()));
