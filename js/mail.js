import { $, esc, cached, hash, local, relTime, updatedText, errorText, safeUrl, showToast } from './util.js';
import { graph, graphWrite, msAccount } from './msauth.js';
import { googleAccount, googleConfigured, gmailApi } from './gauth.js';
import { GMAIL_FEEDS, outlookWebUrl, msClientId } from './settings.js';
import { icon } from './icons.js';
import { deliveriesFrom, deliveriesHtml, deliveryOf, deliveryTag, refreshShippingMail } from './packages.js';

const sources = new Map(); // key -> { kind, label, ... , data, at, error }
let filter = 'all';
let settingsRef;
let shipping = []; // recent shipping emails from the Gmail API, read or not

// Asks the background worker to fetch the feed (see background.js for why).
async function feedRequest(url) {
  const r = await chrome.runtime.sendMessage({ type: 'gmail-feed', url });
  if (!r) throw new Error('Daybook’s background worker didn’t answer. Reload the extension.');
  if (!r.ok) throw new Error(r.error || 'Gmail could not be reached');
  return r;
}

// Gmail's Atom feed answers with the Google session already in Chrome: no API keys,
// unread mail only, newest 20.
async function fetchGmail(index, feedKey = 'inbox') {
  const path = GMAIL_FEEDS[feedKey]?.path ?? '';
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
      at: Date.parse(text(e, 'issued') || text(e, 'modified')) || Date.now(),
      url: link,
    };
  });
  const unread = Math.max(Number(text(feed, 'fullcount')) || 0, items.length);
  // Label feeds (Primary, Important) stop counting at 20.
  return { email, unread, capped: feedKey !== 'inbox' && unread >= 20, items };
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

async function fetchOutlookMail(clientId) {
  const unreadQuery = new URLSearchParams({
    $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false',
    $orderby: 'receivedDateTime desc',
    $top: '25',
    $select: 'id,subject,from,receivedDateTime,bodyPreview,webLink',
  });
  const [folder, list] = await Promise.all([
    graph(clientId, '/me/mailFolders/inbox?$select=unreadItemCount'),
    graph(clientId, `/me/mailFolders/inbox/messages?${unreadQuery}`),
  ]);
  return {
    email: await msAccount(),
    unread: folder.unreadItemCount,
    items: list.value.map((m) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      snippet: m.bodyPreview || '',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown sender',
      at: Date.parse(m.receivedDateTime),
      url: m.webLink,
    })),
  };
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
  if (S.show.packages && googleEmail && accounts.some((a) => a.email === googleEmail) && !hidden.has(googleEmail)) {
    refreshShippingMail(googleEmail, force, (list) => {
      shipping = list;
      render();
    });
  } else shipping = [];
  accounts
    .filter((a) => !hidden.has(a.email))
    .forEach((acct, i) => {
      const key = `gmail:${acct.email}`;
      wanted.add(key);
      if (!sources.has(key)) sources.set(key, { kind: 'gmail', acct, letter: 'G', order: i });
      cached({
        key,
        sig: hash([acct.index, S.gmail.feed]),
        maxAge: 60e3,
        force,
        fetch: async () => {
          const d = await fetchGmail(acct.index, S.gmail.feed);
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
  const clientId = msClientId(S);
  outlookConnected = Boolean(clientId && (await msAccount()));
  if (S.outlook.mail && outlookConnected) {
    wanted.add('outlook');
    cached({
      key: 'outlook-mail',
      sig: clientId,
      maxAge: 2 * 60e3,
      force,
      fetch: () => fetchOutlookMail(clientId),
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
        `<button type="button" class="chip filter${filter === key ? ' on' : ''}" data-mail-filter="${esc(key)}" aria-pressed="${filter === key}" title="${esc(sourceLabel(s))}"><span class="src">${s.letter}</span>${esc(s.kind === 'outlook' ? 'Outlook' : shortLabel(sourceLabel(s)))}<span class="count">${s.data.unread}${s.data.capped ? '+' : ''}</span></button>`,
    ),
  ];
  const items = live
    .filter(([key]) => filter === 'all' || filter === key)
    .flatMap(([key, s]) => s.data.items.map((m) => ({ ...m, key, letter: s.letter, account: sourceLabel(s) })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  const packages = settingsRef.show.packages;
  const deliveries = packages
    ? deliveriesFrom([...live.flatMap(([, s]) => s.data.items.map((m) => ({ ...m, account: sourceLabel(s) }))), ...shipping])
    : [];

  const rows = items.length
    ? `<ol class="mail-list">${items
        .map(
          (m) => `<li><a class="mail" href="${esc(safeUrl(m.url))}">
            <span class="src" title="${esc(m.account)}">${m.letter}</span>
            <span class="mail-from">${esc(m.from)}</span>
            <time class="mail-time" datetime="${new Date(m.at).toISOString()}">${relTime(m.at)}</time>
            <span class="mail-subject">${packages ? deliveryTag(deliveryOf(m)) : ''}${esc(m.subject)}</span>
            <span class="mail-snippet">${esc(m.snippet)}</span>
          </a>${
            canChange(sources.get(m.key))
              ? `<div class="mail-actions">
              <button type="button" class="mail-act" data-mail-act="read" data-key="${esc(m.key)}" data-id="${esc(m.id)}" title="Mark as read" aria-label="Mark as read: ${esc(m.subject)}">${icon('mail-open')}</button>
              <button type="button" class="mail-act danger" data-mail-act="delete" data-key="${esc(m.key)}" data-id="${esc(m.id)}" title="Delete" aria-label="Delete: ${esc(m.subject)}">${icon('trash')}</button>
            </div>`
              : ''
          }</li>`,
        )
        .join('')}</ol>`
    : live.length
      ? `<div class="inbox-zero"><span class="big">0</span><p>Nothing unread${filter === 'all' ? '' : ' here'}. Enjoy it.</p></div>`
      : '';

  const openLinks = list
    .filter(([, s]) => !s.setup)
    .map(([, s]) => `<a class="foot-link" href="${esc(inboxUrl(s))}">${icon('external')}${esc(s.kind === 'outlook' ? 'Outlook' : shortLabel(sourceLabel(s)))}</a>`)
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
  body.innerHTML = `${deliveriesHtml(deliveries)}${live.length > 1 ? `<div class="filters" role="group" aria-label="Show mail from">${chips.join('')}</div>` : ''}${rows}${list.map(([, s]) => notice(s)).join('')}${signIn}`;
  $('#mail-links').innerHTML = openLinks + connectOutlook;
  const ats = list.map(([, s]) => s.at).filter(Boolean);
  $('#mail-updated').textContent = ats.length ? updatedText(Math.min(...ats)) : '';
}

const shortLabel = (s) => (s.includes('@') ? s.split('@')[0] : s);

// ---- Mark as read / delete -----------------------------------------------------------
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
  const moved = await graphWrite(clientId, `${message}/move`, { body: { destinationId: 'deleteditems' } });
  return () => graphWrite(clientId, `/me/messages/${encodeURIComponent(moved.id)}/move`, { body: { destinationId: 'inbox' } });
}

async function change(action, key, id) {
  const src = sources.get(key);
  const item = removeItem(key, id);
  if (!item) return;
  render();
  saveSource(key);
  try {
    const undo = await (src.kind === 'outlook' ? outlookChange(action, item) : gmailChange(action, item));
    const done = action === 'read' ? 'Marked as read' : src.kind === 'outlook' ? 'Moved to Deleted Items' : 'Moved to Trash';
    showToast(done, async () => {
      try {
        await undo();
        restoreItem(key, item);
        render();
        saveSource(key);
      } catch (err) {
        showToast(`Couldn’t undo: ${errorText(err)}.`);
      }
    });
  } catch (err) {
    restoreItem(key, item);
    render();
    saveSource(key);
    showToast(`Couldn’t ${action === 'read' ? 'mark that as read' : 'delete that'}: ${errorText(err)}.`);
  }
}

export function initMail() {
  $('#mail-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-mail-act]');
    if (act) {
      change(act.dataset.mailAct, act.dataset.key, act.dataset.id);
      return;
    }
    const chip = e.target.closest('[data-mail-filter]');
    if (!chip) return;
    filter = chip.dataset.mailFilter;
    render();
  });
}

export const renderMail = render;
