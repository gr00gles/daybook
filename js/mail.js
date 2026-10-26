import { $, esc, cached, hash, local, relTime, updatedText, errorText, safeUrl, showToast } from './util.js';
import { setTicker } from './ticker.js';
import { graph, graphWrite, msAccount, msHas } from './msauth.js';
import { googleAccount, googleConfigured, gmailApi } from './gauth.js';
import { GMAIL_FOLDERS, outlookWebUrl, msClientId, unreadFolders, shippingFolders } from './settings.js';
import { icon, mailMark } from './icons.js';
import { deliveriesFrom, renderDeliveries, deliveryOf, deliveryTag } from './packages.js';
import { refreshShippingMail } from './shipmail.js';
import { openReader, initReader } from './reader.js';

const sources = new Map(); // key -> { kind, label, ... , data, at, error }
let filter = 'all';
let settingsRef;
let shipping = []; // recent shipping emails read in full (shipmail.js), read or not

// Asks the background worker to fetch the feed (see background.js for why).
async function feedRequest(url) {
  const r = await chrome.runtime.sendMessage({ type: 'gmail-feed', url });
  if (!r) throw new Error('Daybook’s background worker didn’t answer. Reload the extension.');
  if (!r.ok) throw new Error(r.error || 'Gmail could not be reached');
  return r;
}

// Gmail's Atom feed answers with the Google session already in Chrome: no API keys,
// unread mail only, newest 20. `path` picks the folder: '' for the inbox, or a tab or label.
async function fetchGmail(index, path = '') {
  const r = await feedRequest(`https://mail.google.com/mail/u/${index}/feed/atom/${path}`);
  if (r.status === 401 || r.status === 403) return { signedOut: true };
  const final = new URL(r.url);
  // Signed out: Gmail sends you to the sign-in page. Past the last signed-in account:
  // it quietly serves account 0 instead.
  if (final.hostname !== 'mail.google.com') return { signedOut: true };
  if (r.redirected && !final.pathname.startsWith(`/mail/u/${index}/`)) return { signedOut: true };
  if (r.status >= 400) throw new Error(`Gmail returned ${r.status}`);
  const xml = new DOMParser().parseFromString(r.text, 'text/xml');
  const feed = xml.getElementsByTagName('feed')[0];
  if (!feed) return { signedOut: true };
  const text = (node, tag) => node.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
  const email = (text(feed, 'title') + ' ' + text(feed, 'tagline')).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]?.toLowerCase() || '';
  if (!email) return { signedOut: true };
  const items = [...feed.getElementsByTagName('entry')].map((e) => {
    const author = e.getElementsByTagName('author')[0];
    const link = (e.getElementsByTagName('link')[0]?.getAttribute('href') || '').replace(/^http:/, 'https:');
    let msgId = '';
    try {
      msgId = new URL(link).searchParams.get('message_id') || '';
    } catch {}
    return {
      msgId,
      id: text(e, 'id'),
      subject: text(e, 'title') || '(no subject)',
      snippet: text(e, 'summary'),
      from: (author && (text(author, 'name') || text(author, 'email'))) || 'Unknown sender',
      fromAddr: (author && text(author, 'email')) || '',
      at: Date.parse(text(e, 'issued') || text(e, 'modified')) || Date.now(),
      url: link,
    };
  });
  const unread = Math.max(Number(text(feed, 'fullcount')) || 0, items.length);
  // Label feeds (Primary, Important) stop counting at 20.
  return { email, unread, capped: path !== '' && unread >= 20, items };
}

// The feeds for one account's folders picked in Settings ({ folders, labels }; see
// unreadFolders), and labels of your own by name.
export function gmailPaths(G) {
  const paths = (G.folders || []).filter((k) => GMAIL_FOLDERS[k]).map((k) => GMAIL_FOLDERS[k].path);
  const labels = String(G.labels || '').split(',').map((l) => l.trim()).filter(Boolean).map(encodeURIComponent);
  const all = [...new Set([...paths, ...labels])].slice(0, 8);
  return all.length ? all : [''];
}
const GMAIL_FOLDERS_PATHS = new Set(Object.values(GMAIL_FOLDERS).map((f) => f.path));
// A feed path as Deliveries names where an email is: a GMAIL_FOLDERS key, or label:name.
const folderOfPath = (p) => Object.keys(GMAIL_FOLDERS).find((k) => GMAIL_FOLDERS[k].path === p) || `label:${decodeURIComponent(p).toLowerCase()}`;

// Each folder is a feed of its own; their unread mail goes together, newest first, once each,
// each email noting the folders it came from (folders).
// A label Gmail doesn't know just adds nothing.
async function fetchGmailFolders(index, G) {
  const paths = gmailPaths(G);
  const feeds = await Promise.all(
    paths.map(async (p) => {
      const label = !GMAIL_FOLDERS_PATHS.has(p);
      try {
        const d = await fetchGmail(index, p);
        return label && d.signedOut ? null : d;
      } catch (err) {
        if (label) return null;
        throw err;
      }
    }),
  );
  const got = feeds.filter(Boolean);
  const out = got.find((d) => d.signedOut);
  if (out || !got.length) return out || { signedOut: true };
  const byId = new Map();
  feeds.forEach((d, i) => {
    for (const m of d?.items || []) {
      if (byId.has(m.id)) byId.get(m.id).folders.push(folderOfPath(paths[i]));
      else byId.set(m.id, { ...m, folders: [folderOfPath(paths[i])] });
    }
  });
  const items = [...byId.values()].sort((a, b) => b.at - a.at);
  // Folders overlap (the inbox holds its tabs), so the count is the biggest, not the sum.
  return { email: got[0].email, unread: Math.max(items.length, ...got.map((d) => d.unread)), capped: got.some((d) => d.capped), items };
}

// Finds every Gmail account signed into this browser by walking /u/0/, /u/1/, … until
// Gmail stops answering with a new account. Remembered for 30 minutes.
export async function discoverGmailAccounts(force = false) {
  const stored = await local.get('gmail:accounts');
  const maxAge = stored?.partial ? 2 * 60e3 : 30 * 60e3;
  if (stored && !force && Date.now() - stored.at < maxAge) return stored.list;
  const list = [];
  let partial = false;
  for (let index = 0; index < 8; index++) {
    let d;
    try {
      d = await fetchGmail(index);
    } catch {
      // A hiccup on one account shouldn't hide the ones after it; look again soon.
      partial = true;
      continue;
    }
    if (d.signedOut || list.some((a) => a.email === d.email)) break;
    list.push({ index, email: d.email, unread: d.unread });
  }
  await local.set('gmail:accounts', { at: Date.now(), list, partial });
  return list;
}

// False when someone limited Daybook's site access in chrome://extensions, which makes
// Gmail look signed out.
export const gmailAllowed = () =>
  chrome.permissions?.contains ? chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }).catch(() => true) : Promise.resolve(true);

export const gmailInboxUrl = (email) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}`;
export const GMAIL_SIGN_IN = 'https://accounts.google.com/AddSession?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';

// Unread mail from each folder picked in Settings (the inbox unless changed), newest first.
async function fetchOutlookMail(clientId, folders) {
  const unreadQuery = new URLSearchParams({
    $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false',
    $orderby: 'receivedDateTime desc',
    $top: '25',
    $select: 'id,subject,from,receivedDateTime,bodyPreview,webLink',
  });
  const ids = folders?.length ? folders.slice(0, 8) : ['inbox'];
  const each = await Promise.all(
    ids.map(async (id) => {
      const f = `/me/mailFolders/${encodeURIComponent(id)}`;
      // A folder deleted since it was picked is skipped, unless it's the only one.
      const [folder, list] = await Promise.all([graph(clientId, `${f}?$select=unreadItemCount`), graph(clientId, `${f}/messages?${unreadQuery}`)]).catch((err) => {
        if (ids.length === 1) throw err;
        return [{ unreadItemCount: 0 }, { value: [] }];
      });
      return { unread: folder.unreadItemCount, messages: list.value.map((m) => ({ ...m, folder: id })) };
    }),
  );
  const messages = each
    .flatMap((f) => f.messages)
    .sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime))
    .slice(0, 25);
  return {
    email: await msAccount(),
    // Outlook's folders don't overlap, so their counts add up.
    unread: each.reduce((sum, f) => sum + f.unread, 0),
    items: messages.map((m) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      snippet: m.bodyPreview || '',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown sender',
      fromAddr: m.from?.emailAddress?.address || '',
      at: Date.parse(m.receivedDateTime),
      url: m.webLink,
      folders: [m.folder],
    })),
  };
}

// Whether Deliveries looks where an unread email of source s came from (m.folders), so the
// emails the Unread card has count for Deliveries too, before (or without) its own search
// reading them. One from before folders were noted counts when Deliveries looks everywhere.
function inShippingFolders(s, m) {
  if (s.kind === 'outlook') {
    const picked = settingsRef.packages.mail.outlook || [];
    return picked.includes('all') || (m.folders || []).some((f) => picked.includes(f));
  }
  const { folders = [], labels = '' } = shippingFolders(settingsRef, s.acct.email);
  if (folders.includes('all')) return !m.folders || m.folders.some((f) => !['promotions', 'social'].includes(f) || folders.includes(f));
  const names = String(labels).split(',').map((l) => `label:${l.trim().toLowerCase()}`);
  return (m.folders || []).some((f) => folders.includes(f) || names.includes(f));
}

export async function refreshMail(S, force) {
  settingsRef = S;
  const wanted = new Set();
  let accounts = [];
  try {
    accounts = await discoverGmailAccounts(force);
  } catch {}
  noGmail = accounts.length === 0;
  googleEmail = googleConfigured() ? (await googleAccount())?.email?.toLowerCase() || '' : '';
  gmailBlocked = noGmail && !(await gmailAllowed());
  const hidden = new Set(S.gmail.hidden || []);
  const clientId = msClientId(S);
  outlookConnected = Boolean(clientId && (await msAccount()));
  if (S.show.packages) {
    // Deliveries has its own choices, apart from the Unread card's: an account or Outlook's mail
    // turned off there is still read for Deliveries, unless nothing is ticked for it here.
    const gmail = accounts.map((a) => ({ ...a, where: shippingFolders(S, a.email) }));
    const outlook = outlookConnected ? clientId : '';
    refreshShippingMail({ gmail, outlook, outlookFolders: S.packages.mail.outlook }, force, (list) => {
      shipping = list;
      render();
    });
  } else if (shipping.length) {
    shipping = [];
  }
  accounts
    .filter((a) => !hidden.has(a.email))
    .forEach((acct, i) => {
      const key = `gmail:${acct.email}`;
      const where = unreadFolders(S, acct.email);
      wanted.add(key);
      if (!sources.has(key)) sources.set(key, { kind: 'gmail', acct, letter: 'G', order: i });
      cached({
        key,
        sig: hash([acct.index, gmailPaths(where)]),
        maxAge: 60e3,
        force,
        fetch: async () => {
          const d = await fetchGmailFolders(acct.index, where);
          // Accounts were added or removed since the last look, so the numbers shifted.
          if (d.signedOut || d.email !== acct.email) {
            local.remove('gmail:accounts');
            throw new Error('Gmail accounts changed. Open a new tab to refresh');
          }
          return d;
        },
        render: (data, meta) => {
          sources.set(key, { kind: 'gmail', acct, letter: 'G', order: i, data, ...meta });
          render();
        },
      });
    });
  if (S.outlook.mail && outlookConnected) {
    wanted.add('outlook');
    cached({
      key: 'outlook-mail',
      sig: hash([clientId, S.outlook.folders]),
      maxAge: 2 * 60e3,
      force,
      fetch: () => fetchOutlookMail(clientId, S.outlook.folders),
      render: (data, meta) => {
        sources.set('outlook', { kind: 'outlook', letter: 'O', order: 99, data, ...meta });
        render();
      },
    });
  }
  for (const key of sources.keys()) if (!wanted.has(key)) sources.delete(key);
  render();
}

let noGmail = false;
let googleEmail = '';
let gmailBlocked = false;
let outlookConnected = false;

function sourceLabel(src) {
  if (src.kind === 'outlook') return src.data?.email || 'Outlook';
  return src.acct.email;
}

function inboxUrl(src) {
  return src.kind === 'outlook' ? outlookWebUrl(src.data?.email) : gmailInboxUrl(src.acct.email);
}

function notice(src) {
  const label = esc(sourceLabel(src));
  if (src.error?.code === 'needs-connect')
    return `<div class="notice warn"><p>${esc(src.error.message)}.</p><button class="btn small" type="button" data-open-settings="accounts">Reconnect Outlook</button></div>`;
  if (src.error)
    return `<p class="notice warn">${label}: ${esc(errorText(src.error))}.${src.data ? ` Showing mail from ${updatedText(src.at).replace('updated ', '')}.` : ''}</p>`;
  return '';
}

function render() {
  const body = $('#mail-body');
  if (!body || !settingsRef) return;
  const list = [...sources.entries()].sort((a, b) => a[1].order - b[1].order);
  const live = list.filter(([, s]) => s.data && !s.data.signedOut);
  if (filter !== 'all' && !live.some(([k]) => k === filter)) filter = 'all';

  const total = live.reduce((n, [, s]) => n + (s.data.unread || 0), 0);
  $('#mail-count').textContent = live.length ? String(total) : '';

  const chips = [
    `<button type="button" class="chip filter${filter === 'all' ? ' on' : ''}" data-mail-filter="all" aria-pressed="${filter === 'all'}">All<span class="count">${total}</span></button>`,
    ...live.map(
      ([key, s]) =>
        `<button type="button" class="chip filter${filter === key ? ' on' : ''}" data-mail-filter="${esc(key)}" aria-pressed="${filter === key}" title="${esc(sourceLabel(s))}"><span class="src ${s.kind}">${s.letter}</span>${esc(s.kind === 'outlook' ? 'Outlook' : shortLabel(sourceLabel(s)))}<span class="count">${s.data.unread}${s.data.capped ? '+' : ''}</span></button>`,
    ),
  ];
  const items = live
    .filter(([key]) => filter === 'all' || filter === key)
    .flatMap(([key, s]) => s.data.items.map((m) => ({ ...m, key, letter: s.letter, kind: s.kind, account: sourceLabel(s) })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  setTicker(
    'mail',
    live
      .flatMap(([, s]) => s.data.items)
      .sort((a, b) => b.at - a.at)
      .map((m) => ({ tag: m.from, title: m.subject, meta: relTime(m.at), href: m.url })),
  );
  const packages = settingsRef.show.packages;
  // Deliveries come from the shipping emails found in the folders picked for them, read in full,
  // and the unread emails here from those same folders (see inShippingFolders). The ones read in
  // full go first, so they count over their unread copies; they tag the rows below too.
  const readInFull = new Map(shipping.map((m) => [m.msgId, m]));
  const unreadThere = live.flatMap(([, s]) => s.data.items.filter((m) => inShippingFolders(s, m)).map((m) => ({ ...m, account: sourceLabel(s) })));
  const deliveries = packages ? deliveriesFrom([...shipping, ...unreadThere]) : [];
  if (packages) renderDeliveries(deliveries);

  const rows = items.length
    ? `<ol class="mail-list">${items
        .map(
          (m) => `<li><a class="mail" href="${esc(safeUrl(m.url))}" data-open-key="${esc(m.key)}" data-open-id="${esc(m.id)}">
            <span class="src ${m.kind}" title="${esc(m.account)}">${m.letter}</span>
            <span class="mail-from">${esc(m.from)}</span>
            <time class="mail-time" datetime="${new Date(m.at).toISOString()}">${relTime(m.at)}</time>
            <span class="mail-subject">${packages ? deliveryTag(deliveryOf(readInFull.get(m.msgId || m.id) || m)) : ''}${esc(m.subject)}</span>
            <span class="mail-snippet">${esc(m.snippet)}</span>
          </a>${
            canChange(sources.get(m.key))
              ? `<div class="mail-actions">
              <button type="button" class="mail-act" data-mail-act="read" data-key="${esc(m.key)}" data-id="${esc(m.id)}" title="Mark as read" aria-label="Mark as read: ${esc(m.subject)}">${icon('mail-open')}</button>
              <button type="button" class="mail-act" data-mail-act="junk" data-key="${esc(m.key)}" data-id="${esc(m.id)}" title="Junk" aria-label="Junk: ${esc(m.subject)}">${icon('junk')}</button>
              <button type="button" class="mail-act danger" data-mail-act="delete" data-key="${esc(m.key)}" data-id="${esc(m.id)}" title="Delete" aria-label="Delete: ${esc(m.subject)}">${icon('trash')}</button>
            </div>`
              : ''
          }</li>`,
        )
        .join('')}</ol>`
    : live.length
      ? `<p class="quiet is-empty">Nothing unread${filter === 'all' ? '' : ' here'}. Enjoy it.</p>`
      : '';

  const openLinks = list
    .filter(([, s]) => !s.setup)
    .map(([, s]) => {
      const name = s.kind === 'outlook' ? 'Outlook' : 'Gmail';
      return `<a class="foot-link" href="${esc(inboxUrl(s))}" title="Open ${name}" aria-label="Open ${name}: ${esc(sourceLabel(s))}">${mailMark(s.kind)}${esc(sourceLabel(s))}</a>`;
    })
    .join('');

  const signIn = gmailBlocked
    ? `<p class="notice warn">Daybook isn’t allowed to read Gmail. In <code>chrome://extensions</code>, open Daybook’s <strong>Details</strong> and set <strong>Site access</strong> to <strong>On all sites</strong>.</p>`
    : noGmail
    ? `<div class="notice setup"><p><strong>No Gmail account is signed in to Chrome.</strong> Sign in to Gmail and your unread mail shows up here.</p><a class="btn small primary" href="${GMAIL_SIGN_IN}">Sign in to Gmail</a></div>`
    : '';
  const connectOutlook =
    settingsRef.outlook.mail && !outlookConnected && msClientId(settingsRef)
      ? `<button class="foot-link" type="button" data-open-settings="accounts">${icon('plus')}Connect Outlook</button>`
      : '';
  body.innerHTML = `${live.length > 1 && (total || filter !== 'all') ? `<div class="filters" role="group" aria-label="Show mail from">${chips.join('')}</div>` : ''}${rows}${list.map(([, s]) => notice(s)).join('')}${signIn}`;
  $('#mail-links').innerHTML = openLinks + connectOutlook;
}

const shortLabel = (s) => (s.includes('@') ? s.split('@')[0] : s);

// ---- Mark as read / junk / delete ----------------------------------------------------
// Outlook: any connected account. Gmail: only the account connected under Google, because
// that's the one Chrome can get permission for.
function canChange(src) {
  if (!src?.data) return false;
  if (src.kind === 'outlook') return true;
  return Boolean(googleEmail && src.acct.email === googleEmail);
}

const cacheKeyFor = (key) => (key === 'outlook' ? 'outlook-mail' : key);

async function saveSource(key) {
  const stored = await local.get(`cache:${cacheKeyFor(key)}`);
  const src = sources.get(key);
  if (stored && src?.data) await local.set(`cache:${cacheKeyFor(key)}`, { ...stored, data: src.data });
}

function removeItem(key, id) {
  const src = sources.get(key);
  const item = src?.data?.items.find((m) => m.id === id);
  if (!item) return null;
  src.data = { ...src.data, items: src.data.items.filter((m) => m !== item), unread: Math.max(0, (src.data.unread || 0) - 1) };
  return item;
}

function restoreItem(key, item) {
  const src = sources.get(key);
  if (!src?.data || src.data.items.some((m) => m.id === item.id)) return;
  src.data = { ...src.data, items: [...src.data.items, item], unread: (src.data.unread || 0) + 1 };
}

async function gmailChange(action, item) {
  if (!item.msgId) throw new Error('open this message in Gmail to change it');
  // The feed lists conversations, so act on the whole thread.
  const { threadId } = await gmailApi(`/messages/${encodeURIComponent(item.msgId)}?format=minimal&fields=threadId`, { method: 'GET' });
  const thread = `/threads/${encodeURIComponent(threadId)}`;
  if (action === 'read') {
    await gmailApi(`${thread}/modify`, { body: { removeLabelIds: ['UNREAD'] } });
    return () => gmailApi(`${thread}/modify`, { body: { addLabelIds: ['UNREAD'] } });
  }
  // Labelling it SPAM is Gmail's Report spam: it moves to Spam and teaches the filter.
  if (action === 'junk') {
    await gmailApi(`${thread}/modify`, { body: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } });
    return () => gmailApi(`${thread}/modify`, { body: { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] } });
  }
  await gmailApi(`${thread}/trash`);
  return () => gmailApi(`${thread}/untrash`);
}

async function outlookChange(action, item) {
  const clientId = msClientId(settingsRef);
  const message = `/me/messages/${encodeURIComponent(item.id)}`;
  if (action === 'read') {
    await graphWrite(clientId, message, { method: 'PATCH', body: { isRead: true } });
    return () => graphWrite(clientId, message, { method: 'PATCH', body: { isRead: false } });
  }
  const moved = await graphWrite(clientId, `${message}/move`, { body: { destinationId: action === 'junk' ? 'junkemail' : 'deleteditems' } });
  return () => graphWrite(clientId, `/me/messages/${encodeURIComponent(moved.id)}/move`, { body: { destinationId: 'inbox' } });
}

// What the toast says afterwards, for Gmail and for Outlook.
const DONE = {
  read: ['Marked as read', 'Marked as read'],
  junk: ['Reported as spam', 'Moved to Junk Email'],
  delete: ['Moved to Trash', 'Moved to Deleted Items'],
};
const FAILED = { read: 'mark that as read', junk: 'move that to junk', delete: 'delete that' };

// Resolves to a function that undoes the change, or null if it didn't happen.
// `opts.item` lets the reader delete a message it already marked read (no longer listed).
async function change(action, key, id, { toast = true, item: known = null } = {}) {
  const src = sources.get(key);
  const listed = removeItem(key, id);
  const item = listed || known;
  if (!item || !src) return null;
  // Only messages that were in the Unread list go back into it.
  const putBack = () => {
    if (!listed) return;
    restoreItem(key, item);
    render();
    saveSource(key);
  };
  render();
  saveSource(key);
  try {
    const undo = await (src.kind === 'outlook' ? outlookChange(action, item) : gmailChange(action, item));
    const restore = async () => {
      await undo();
      putBack();
    };
    const done = DONE[action][src.kind === 'outlook' ? 1 : 0];
    if (toast)
      showToast(done, async () => {
        try {
          await restore();
        } catch (err) {
          showToast(`Couldn’t undo: ${errorText(err).replace(/[.\s]+$/, '')}.`);
        }
      });
    return restore;
  } catch (err) {
    putBack();
    // Without a toast (the reader asked), the caller reports it where it can be seen.
    if (!toast) throw err;
    showToast(`Couldn’t ${FAILED[action]}: ${errorText(err).replace(/[.\s]+$/, '')}.`);
    return null;
  }
}

// Clicking a message opens it here. Ctrl/⌘-click or the middle button still opens it in
// Gmail or Outlook, as does the button in the reader.
async function openMessage(key, id) {
  const src = sources.get(key);
  const item = src?.data?.items.find((m) => m.id === id);
  if (!item) return;
  const outlook = src.kind === 'outlook';
  const editable = canChange(src);
  openReader({
    item,
    how: outlook ? 'outlook' : editable && item.msgId ? 'gmail' : null,
    clientId: msClientId(settingsRef),
    providerUrl: safeUrl(item.url),
    providerName: outlook ? 'Outlook' : 'Gmail',
    account: sourceLabel(src),
    letter: src.letter,
    actions: editable ? { change: (action, opts) => change(action, key, id, { ...opts, item }) } : null,
    // Reading Gmail here already uses the permission that marks it read; Outlook needs one
    // more, so it's only marked read on its own once that was given.
    autoRead: outlook ? await msHas('Mail.ReadWrite') : true,
  });
}

export function initMail() {
  initReader();
  $('#mail-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-mail-act]');
    if (act) {
      change(act.dataset.mailAct, act.dataset.key, act.dataset.id);
      return;
    }
    const open = e.target.closest('a[data-open-key]');
    if (open && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      openMessage(open.dataset.openKey, open.dataset.openId);
      return;
    }
    const chip = e.target.closest('[data-mail-filter]');
    if (!chip) return;
    filter = chip.dataset.mailFilter;
    render();
  });
}

export const renderMail = render;
