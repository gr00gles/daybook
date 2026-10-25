// Sign-in and location controls shared by the first-run setup screen and Settings.
// Each mount() renders into an element, keeps its own small state, and writes choices into
// `draft` (the settings being edited), calling `changed()` after every edit.
import { esc, colorVar, getJSON } from './util.js';
import { googleConfigured, googleAccount, connectGoogle, disconnectGoogle } from './gauth.js';
import { listGoogleCalendars } from './calendar.js';
import { discoverGmailAccounts, gmailAllowed, GMAIL_SIGN_IN } from './mail.js';
import { lastShippingReport } from './shipmail.js';
import { connect as msConnect, disconnect as msDisconnect, msAccount, adminConsentUrl, graph } from './msauth.js';
import { msClientId, GMAIL_FOLDERS, unreadFolders, shippingFolders } from './settings.js';
import { icon } from './icons.js';

const check = '<svg class="ok-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const connected = (who) => `<p class="acct-status">${check}<span>Connected as <strong>${esc(who)}</strong></span></p>`;
const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;

// ---- Google (Calendar) -------------------------------------------------------------

export function mountGoogle(el, draft, changed, { onConnected } = {}) {
  const s = { account: null, calendars: null, busy: false, error: '', loading: true };

  const paint = () => {
    if (!googleConfigured()) {
      el.innerHTML = `<p class="hint">Google sign-in isn’t set up in this copy of Daybook. You can still add Google calendars by iCal link in Settings.</p>`;
      return;
    }
    if (s.loading) {
      el.innerHTML = '<p class="hint">Checking…</p>';
      return;
    }
    if (!s.account) {
      el.innerHTML = `
        ${s.busy
          ? `<div class="pending"><span class="spinner" aria-hidden="true"></span><p>Finish signing in in the Google window. <button class="linklike" type="button" data-g="reset">Start over</button></p></div>`
          : `<button class="btn primary big" type="button" data-g="connect">Sign in with Google</button>`}
        ${s.error ? `<p class="notice warn">${esc(s.error)}</p>` : ''}`;
      return;
    }
    const shown = new Set(Array.isArray(draft.google.calendars) ? draft.google.calendars : (s.calendars || []).filter((c) => c.selected).map((c) => c.id));
    el.innerHTML = `
      <div class="acct-row">${connected(s.account.email || s.account.name || 'your Google account')}<button class="btn small" type="button" data-g="disconnect">Disconnect</button></div>
      ${s.calendars
        ? `<fieldset class="cal-pick"><legend>Calendars to show</legend>${s.calendars
            .map(
              (c) => `<label class="check"><input type="checkbox" data-gcal="${esc(c.id)}"${shown.has(c.id) ? ' checked' : ''}><span class="cal-dot" style="--c: ${colorVar(c.color)}"></span><span>${esc(c.name)}</span></label>`,
            )
            .join('')}</fieldset>`
        : ''}
      ${s.error ? `<p class="notice warn">${esc(s.error)}</p>` : ''}`;
  };

  const loadCalendars = async (force) => {
    try {
      s.calendars = await listGoogleCalendars(force);
      s.error = '';
    } catch (err) {
      s.calendars = null;
      s.error = err.message || String(err);
      if (err.code === 'needs-google') s.account = null;
    }
  };

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    const action = b.dataset.g;
    if (action === 'reset') {
      s.busy = false;
      paint();
    } else if (action === 'connect') {
      s.busy = true;
      s.error = '';
      paint();
      try {
        s.account = await connectGoogle();
        await loadCalendars(true);
        if (!draft.name && s.account.givenName) {
          draft.name = s.account.givenName;
          changed('name');
        }
        changed('google');
        onConnected?.(s.account);
      } catch (err) {
        s.error = err.message || String(err);
      }
      s.busy = false;
      paint();
    } else if (action === 'disconnect') {
      await disconnectGoogle();
      Object.assign(s, { account: null, calendars: null, error: '' });
      draft.google.calendars = null;
      changed('google');
      paint();
    }
  });

  el.addEventListener('change', (e) => {
    if (!e.target.dataset.gcal) return;
    draft.google.calendars = [...el.querySelectorAll('[data-gcal]')].filter((i) => i.checked).map((i) => i.dataset.gcal);
    changed('google');
  });

  (async () => {
    if (googleConfigured()) {
      s.account = await googleAccount();
      if (s.account) await loadCalendars(false);
    }
    s.loading = false;
    paint();
  })();
  paint();
}

// ---- Folders -----------------------------------------------------------------------

// One Gmail account's folder ticks and labels box, for the Unread card (attr m) or Deliveries
// (attr s, with All mail first). choice is { folders, labels }.
function gmailPick(email, choice, { legend, attr, all = false }) {
  const box = (k, label) =>
    `<label class="check"><input type="checkbox" data-${attr}-folder="${k}" data-acct="${esc(email)}"${choice.folders?.includes(k) ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  return `<fieldset class="cal-pick folder-pick"><legend>${esc(legend)}</legend>
      ${all ? box('all', 'All mail') : ''}${Object.entries(GMAIL_FOLDERS).map(([k, f]) => box(k, f.label)).join('')}
    </fieldset>
    <label class="field"><span>Labels of your own</span><input type="text" data-${attr}-labels data-acct="${esc(email)}" value="${esc(choice.labels || '')}" placeholder="Receipts, Family" spellcheck="false" autocomplete="off"></label>`;
}

// What a gmailPick for `email` has ticked and typed now.
function readPick(el, attr, email) {
  const mine = (sel) => [...el.querySelectorAll(sel)].filter((i) => i.dataset.acct === email);
  return {
    folders: mine(`[data-${attr}-folder]`).filter((i) => i.checked).map((i) => i.dataset[`${attr}Folder`]),
    labels: mine(`[data-${attr}-labels]`)[0]?.value.trim() || '',
  };
}

// The Outlook account's top-level mail folders, the inbox first, each by id ('inbox' for the
// inbox, so a choice means the same after Outlook renumbers it). Empty when they can't be listed.
async function outlookFolders(clientId) {
  try {
    const [inbox, list] = await Promise.all([graph(clientId, '/me/mailFolders/inbox?$select=id'), graph(clientId, '/me/mailFolders?$top=100&$select=id,displayName,unreadItemCount')]);
    return list.value
      .map((f) => ({ id: f.id === inbox.id ? 'inbox' : f.id, name: f.displayName, unread: f.unreadItemCount }))
      .sort((a, b) => (b.id === 'inbox') - (a.id === 'inbox'));
  } catch {
    return [];
  }
}

// ---- Gmail -------------------------------------------------------------------------

export function mountGmail(el, draft, changed) {
  const s = { accounts: null, loading: true };

  const paint = () => {
    if (s.loading) {
      el.innerHTML = '<p class="hint"><span class="spinner small" aria-hidden="true"></span> Looking for Gmail accounts signed in to Chrome…</p>';
      return;
    }
    const hidden = new Set(draft.gmail.hidden || []);
    if (s.blocked) {
      el.innerHTML = `<p class="notice warn">Daybook isn’t allowed to read Gmail. In <code>chrome://extensions</code>, open Daybook’s <strong>Details</strong>, set <strong>Site access</strong> to <strong>On all sites</strong>, then <button class="linklike" type="button" data-m="rescan">look again</button>.</p>`;
      return;
    }
    if (!s.accounts.length) {
      el.innerHTML = `
        <p class="hint">No Gmail account is signed in to this browser yet.</p>
        <div class="row-actions">
          <a class="btn primary" href="${GMAIL_SIGN_IN}" target="_blank" rel="noopener">Sign in to Gmail</a>
          <button class="btn" type="button" data-m="rescan">I’ve signed in</button>
        </div>
        <p class="hint small">Daybook checks again when you come back to this tab.</p>`;
      return;
    }
    el.innerHTML = `
      <fieldset class="cal-pick"><legend>${s.accounts.length === 1 ? 'Gmail account found' : `${s.accounts.length} Gmail accounts found`}</legend>
        ${s.accounts
          .map(
            (a) => `<div class="acct-mail"><label class="check"><input type="checkbox" data-gmail="${esc(a.email)}"${hidden.has(a.email) ? '' : ' checked'}><span class="src">G</span><span>${esc(a.email)}</span><span class="count">${a.unread} unread</span></label>
            ${hidden.has(a.email) ? '' : `<div class="acct-folders">${gmailPick(a.email, unreadFolders(draft, a.email), { legend: 'Show unread mail from', attr: 'm' })}</div>`}</div>`,
          )
          .join('')}
      </fieldset>
      <p class="hint small">Each account has its own choice. The inbox already holds its tabs (Primary, Social and the rest), so tick a tab instead of the inbox to see only that one. Type labels as Gmail names them, separated by commas.</p>
      <div class="row-actions">
        <a class="btn small" href="${GMAIL_SIGN_IN}" target="_blank" rel="noopener">${icon('plus')}Add another account</a>
        <button class="btn small" type="button" data-m="rescan">${icon('refresh')}Look again</button>
      </div>`;
  };

  const scan = async (force) => {
    s.loading = true;
    paint();
    s.accounts = await discoverGmailAccounts(force).catch(() => []);
    s.blocked = !s.accounts.length && !(await gmailAllowed());
    s.loading = false;
    paint();
  };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-m="rescan"]')) scan(true);
  });
  el.addEventListener('change', (e) => {
    const email = e.target.dataset.acct;
    if (e.target.dataset.gmail !== undefined) {
      draft.gmail.hidden = [...el.querySelectorAll('[data-gmail]')].filter((i) => !i.checked).map((i) => i.dataset.gmail);
      changed('gmail');
      paint();
    } else if (email && (e.target.dataset.mFolder || e.target.dataset.mLabels !== undefined)) {
      draft.gmail.accounts = { ...draft.gmail.accounts, [email]: readPick(el, 'm', email) };
      changed('gmail');
    }
  });
  // Coming back from the Gmail sign-in tab: look again.
  const onFocus = () => {
    if (el.isConnected && !s.loading) scan(true);
  };
  window.addEventListener('focus', onFocus);
  scan(false);
}

// ---- Outlook -----------------------------------------------------------------------

export function mountOutlook(el, draft, changed, { onConnected } = {}) {
  const s = { account: null, busy: false, error: '', adminUrl: '', loading: true };

  const paint = () => {
    const clientId = msClientId(draft);
    if (!clientId) {
      el.innerHTML = '<p class="hint">Outlook sign-in isn’t set up in this copy of Daybook.</p>';
      return;
    }
    if (s.loading) {
      el.innerHTML = '<p class="hint">Checking…</p>';
      return;
    }
    if (s.account) {
      el.innerHTML = `
        <div class="acct-row">${connected(s.account)}<button class="btn small" type="button" data-o="disconnect">Disconnect</button></div>
        <div class="row-actions">
          <label class="check"><input type="checkbox" data-o="mail"${draft.outlook.mail ? ' checked' : ''}><span>Show Outlook mail</span></label>
          <label class="check"><input type="checkbox" data-o="calendar"${draft.outlook.calendar ? ' checked' : ''}><span>Show Outlook calendar</span></label>
        </div>
        ${draft.outlook.mail ? folderPick() : ''}`;
      return;
    }
    el.innerHTML = `
      ${s.busy
        ? `<div class="pending"><span class="spinner" aria-hidden="true"></span><p>Finish signing in in the Microsoft window. <button class="linklike" type="button" data-o="reset">Start over</button></p></div>`
        : '<button class="btn primary big" type="button" data-o="connect">Sign in with Microsoft</button>'}
      ${s.adminUrl
        ? `<div class="notice warn"><p><strong>Your organization has to approve Daybook first.</strong> Work and school accounts usually can’t approve mail access themselves. Send this link to your IT admin. After they approve, the page may say it can’t be reached; that’s expected. Then sign in here again.</p>
            <div class="copy-row"><code id="ms-admin-url">${esc(s.adminUrl)}</code><button class="btn small" type="button" data-o="copy-admin">${icon('copy')}Copy</button></div></div>`
        : s.error
          ? `<div class="notice warn"><p>${esc(s.error)}</p>
              <details><summary>Using a work or school account?</summary>
                <p>If Microsoft said your organization needs to approve Daybook, send this link to your IT admin. After they approve, the page may say it can’t be reached; that’s expected. Then sign in here again.</p>
                <div class="copy-row"><code id="ms-admin-url">${esc(adminConsentUrl(msClientId(draft)))}</code><button class="btn small" type="button" data-o="copy-admin">${icon('copy')}Copy</button></div>
              </details></div>`
          : ''}`;
  };

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-o]');
    if (!b || b.tagName === 'INPUT') return;
    const action = b.dataset.o;
    if (action === 'reset') {
      s.busy = false;
      paint();
    } else if (action === 'connect') {
      Object.assign(s, { busy: true, error: '', adminUrl: '' });
      paint();
      try {
        const auth = await msConnect(msClientId(draft));
        s.account = auth.account;
        if (!draft.name && auth.givenName) {
          draft.name = auth.givenName;
          changed('name');
        }
        changed('outlook');
        onConnected?.(auth);
        loadFolders();
      } catch (err) {
        if (err.code === 'needs-admin') s.adminUrl = err.adminUrl;
        else s.error = err.message || String(err);
      }
      s.busy = false;
      paint();
    } else if (action === 'disconnect') {
      await msDisconnect();
      s.account = null;
      changed('outlook');
      paint();
    } else if (action === 'copy-admin') {
      try {
        await navigator.clipboard.writeText(s.adminUrl || adminConsentUrl(msClientId(draft)));
        b.lastChild.textContent = 'Copied';
      } catch {
        getSelection().selectAllChildren(el.querySelector('#ms-admin-url'));
      }
    }
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.o;
    if (k === 'mail' || k === 'calendar') {
      draft.outlook[k] = e.target.checked;
      changed('outlook');
      if (k === 'mail') paint();
    } else if (e.target.dataset.oFolder) {
      draft.outlook.folders = [...el.querySelectorAll('[data-o-folder]')].filter((i) => i.checked).map((i) => i.dataset.oFolder);
      changed('outlook');
    }
  });

  const folderPick = () => {
    if (!s.folders) return '<p class="hint">Looking for your Outlook folders…</p>';
    if (!s.folders.length) return '<p class="hint">Couldn’t list your Outlook folders; showing the inbox.</p>';
    const picked = draft.outlook.folders?.length ? draft.outlook.folders : ['inbox'];
    return `<fieldset class="cal-pick folder-pick"><legend>Show unread mail from</legend>${s.folders
      .map((f) => `<label class="check"><input type="checkbox" data-o-folder="${esc(f.id)}"${picked.includes(f.id) ? ' checked' : ''}><span>${esc(f.name)}</span>${f.unread ? `<span class="count">${f.unread} unread</span>` : ''}</label>`)
      .join('')}</fieldset>`;
  };
  const loadFolders = async () => {
    s.folders = await outlookFolders(msClientId(draft));
    paint();
  };

  (async () => {
    s.account = await msAccount();
    s.loading = false;
    paint();
    if (s.account) loadFolders();
  })();
  paint();
}

// ---- Deliveries --------------------------------------------------------------------

// Where Deliveries looks for shipping emails, for each Gmail account signed in (the first three)
// and the Outlook mailbox: All mail or the whole mailbox, or folders and labels. Its own choice,
// whatever the Unread card shows. Writes draft.packages.mail.
export function mountShippingFolders(el, draft, changed) {
  const s = { accounts: null, outlook: '', folders: null, report: null };
  const M = () => draft.packages.mail;
  // What the last search found there, or why it couldn't look.
  const lastLook = (source) => {
    const r = s.report?.sources?.[source];
    if (!r) return '';
    const when = new Date(s.report.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return r.error
      ? `<p class="notice warn small">The last look (${esc(when)}) couldn’t search here: ${esc(r.error)}.</p>`
      : `<p class="hint small">The last look (${esc(when)}) found ${r.found} ${r.found === 1 ? 'email' : 'emails'} about orders here${r.found ? `, ${r.full} read in full` : ''}.</p>`;
  };

  const paint = () => {
    if (!s.accounts) {
      el.innerHTML = '<p class="hint">Looking for your accounts…</p>';
      return;
    }
    const gmail = s.accounts;
    const outlook = s.outlook;
    if (!gmail.length && !outlook) {
      el.innerHTML = '<p class="hint">Sign in to Gmail or Outlook under Accounts, and their shipping emails show up here to choose from.</p>';
      return;
    }
    const picked = M().outlook || [];
    const box = (id, label) => `<label class="check"><input type="checkbox" data-s-outlook="${esc(id)}"${picked.includes(id) ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    el.innerHTML = `
      ${gmail
        .slice(0, 3)
        .map((a) => `<div class="acct-mail">${gmailPick(a.email, shippingFolders(draft, a.email), { legend: a.email, attr: 's', all: true })}${lastLook(`gmail:${a.email}`)}</div>`)
        .join('')}
      ${gmail.length > 3 ? `<p class="hint small">Deliveries reads the first three Gmail accounts; ${gmail.slice(3).map((a) => esc(a.email)).join(', ')} ${gmail.length === 4 ? 'isn’t' : 'aren’t'} read.</p>` : ''}
      ${outlook
        ? `<div class="acct-mail"><fieldset class="cal-pick folder-pick"><legend>Outlook (${esc(s.outlook)})</legend>
            ${box('all', 'Whole mailbox')}${s.folders ? s.folders.map((f) => box(f.id, f.name)).join('') : ''}
          </fieldset>${s.folders ? '' : '<p class="hint small">Looking for your Outlook folders…</p>'}${lastLook('outlook')}</div>`
        : ''}
      <p class="hint small">These are apart from the Unread card’s folders under Accounts. All mail is the inbox, archived mail and every label, but not Spam or Trash, and it leaves out Promotions and Social unless you tick them too. Outlook’s whole mailbox is every folder. With nothing ticked, Deliveries doesn’t look in that account.</p>`;
  };

  el.addEventListener('change', (e) => {
    const t = e.target;
    const email = t.dataset.acct;
    if (email && (t.dataset.sFolder || t.dataset.sLabels !== undefined)) {
      M().gmail = { ...M().gmail, [email]: readPick(el, 's', email) };
    } else if (t.dataset.sOutlook) {
      M().outlook = [...el.querySelectorAll('[data-s-outlook]')].filter((i) => i.checked).map((i) => i.dataset.sOutlook);
    } else return;
    changed('packages');
  });

  (async () => {
    s.accounts = await discoverGmailAccounts(false).catch(() => []);
    s.report = await lastShippingReport();
    const clientId = msClientId(draft);
    s.outlook = clientId ? (await msAccount().catch(() => null)) || '' : '';
    paint();
    if (s.outlook) {
      s.folders = await outlookFolders(clientId);
      paint();
    }
  })();
  paint();
}

// ---- Weather location --------------------------------------------------------------

export function mountLocation(el, draft, changed) {
  let results = [];
  let timer;
  const paint = () => {
    const manual = draft.location.mode === 'manual';
    el.innerHTML = `
      <div class="radio-row">
        <label class="check"><input type="radio" name="locmode-${el.id}" value="auto"${manual ? '' : ' checked'}><span>Use my location</span></label>
        <label class="check"><input type="radio" name="locmode-${el.id}" value="manual"${manual ? ' checked' : ''}><span>A city I choose</span></label>
      </div>
      ${manual ? `<p class="hint">${draft.location.name ? `Showing weather for <strong>${esc(draft.location.name)}</strong>.` : 'Search for your city below.'}</p>
      <label class="field"><span>Find a city</span><input id="${el.id}-q" type="search" placeholder="Brooklyn, Austin, London…" autocomplete="off"></label>
      <div class="city-results"></div>` : '<p class="hint">Chrome shares your approximate location with Daybook for the forecast.</p>'}`;
  };
  el.addEventListener('change', (e) => {
    if (e.target.type !== 'radio') return;
    draft.location.mode = e.target.value;
    changed('location');
    paint();
    if (e.target.value === 'manual') el.querySelector('input[type="search"]')?.focus();
  });
  el.addEventListener('input', (e) => {
    if (e.target.type !== 'search') return;
    clearTimeout(timer);
    const q = e.target.value.trim();
    timer = setTimeout(async () => {
      const box = el.querySelector('.city-results');
      if (q.length < 2) {
        box.innerHTML = '';
        return;
      }
      try {
        const r = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '6', language: 'en' })}`);
        results = r.results || [];
        box.innerHTML = results.length
          ? results.map((c, i) => `<button type="button" class="city" data-city="${i}">${esc(c.name)}<span>${esc([c.admin1, c.country].filter(Boolean).join(', '))}</span></button>`).join('')
          : '<p class="hint">No matches.</p>';
      } catch {
        box.innerHTML = '<p class="hint">City search isn’t reachable right now.</p>';
      }
    }, 300);
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-city]');
    if (!b) return;
    const c = results[Number(b.dataset.city)];
    const region = c.country_code === 'US' ? c.admin1 : c.country;
    draft.location = { mode: 'manual', name: [c.name, region].filter(Boolean).join(', '), lat: +c.latitude.toFixed(3), lon: +c.longitude.toFixed(3) };
    changed('location');
    paint();
  });
  paint();
}
