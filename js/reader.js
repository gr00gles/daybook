// Reading an email on the page. The message is fetched when you open it (Gmail API for the
// Google account connected in Daybook, Microsoft Graph for Outlook) and shown in a sandboxed
// frame: no scripts, links open in a new tab, and pictures from the web stay blocked until you
// ask for them, since they tell the sender you opened the email. Nothing is stored.
import { $, esc, errorText } from './util.js';
import { gmailApi } from './gauth.js';
import { graph } from './msauth.js';
import { icon } from './icons.js';

const reason = (err) => errorText(err).replace(/[.\s]+$/, '');
const loaded = new Map(); // message id -> message, for this tab only

// ---- Gmail -------------------------------------------------------------------------------

const b64ToBytes = (data) => {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const toStdB64 = (data) => data.replace(/-/g, '+').replace(/_/g, '/');
const headerOf = (part, name) => part?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';

function decodeText(data, contentType) {
  const charset = /charset="?([\w-]+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(b64ToBytes(data));
  } catch {
    return new TextDecoder('utf-8').decode(b64ToBytes(data));
  }
}

// The message's HTML (or text) body and its attachments, from Gmail's part tree.
function walk(part, out) {
  const type = (part.mimeType || '').toLowerCase();
  if (part.filename) {
    const cid = headerOf(part, 'content-id').replace(/[<>]/g, '');
    out.files.push({ name: part.filename, size: part.body?.size || 0, type, id: part.body?.attachmentId, data: part.body?.data, cid });
    return;
  }
  if (type === 'text/html' && !out.html) out.html = part;
  else if (type === 'text/plain' && !out.text) out.text = part;
  for (const p of part.parts || []) walk(p, out);
}

async function partText(msgId, part) {
  let data = part.body?.data;
  // Long bodies come separately, like attachments.
  if (!data && part.body?.attachmentId) data = (await gmailApi(`/messages/${msgId}/attachments/${part.body.attachmentId}`, { method: 'GET' })).data;
  return data ? decodeText(data, headerOf(part, 'content-type')) : '';
}

async function gmailMessage(msgId) {
  const m = await gmailApi(`/messages/${encodeURIComponent(msgId)}?format=full`, { method: 'GET' });
  const out = { files: [] };
  walk(m.payload || {}, out);
  const body = out.html ? { html: await partText(msgId, out.html) } : { text: out.text ? await partText(msgId, out.text) : m.snippet || '' };
  // Pictures that are part of the email itself (logos, signatures): small ones, inline.
  const inline = new Map();
  const pics = out.files.filter((f) => f.cid && f.type.startsWith('image/') && f.size < 1.5e6).slice(0, 10);
  await Promise.all(
    pics.map(async (f) => {
      try {
        const data = f.data || (await gmailApi(`/messages/${msgId}/attachments/${f.id}`, { method: 'GET' })).data;
        if (data) inline.set(f.cid, `data:${f.type};base64,${toStdB64(data)}`);
      } catch {}
    }),
  );
  const h = (n) => headerOf(m.payload, n);
  return {
    ...body,
    from: h('from'),
    to: h('to'),
    cc: h('cc'),
    date: Number(m.internalDate) || Date.parse(h('date')) || 0,
    files: out.files.filter((f) => !inline.has(f.cid)).map(({ name, size }) => ({ name, size })),
    inline,
  };
}

// ---- Outlook -----------------------------------------------------------------------------

const person = (r) => (r?.emailAddress ? (r.emailAddress.name && r.emailAddress.name !== r.emailAddress.address ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address) : '');

async function outlookMessage(clientId, id) {
  const base = `/me/messages/${encodeURIComponent(id)}`;
  const m = await graph(clientId, `${base}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`, {
    Prefer: 'outlook.body-content-type="html"',
  });
  let files = [];
  const inline = new Map();
  if (m.hasAttachments) {
    try {
      const list = (await graph(clientId, `${base}/attachments?$select=id,name,size,isInline,contentType`)).value || [];
      const pics = list.filter((a) => a.isInline && /^image\//.test(a.contentType || '') && a.size < 1.5e6).slice(0, 10);
      await Promise.all(
        pics.map(async (a) => {
          try {
            const full = await graph(clientId, `${base}/attachments/${encodeURIComponent(a.id)}`);
            if (full.contentId && full.contentBytes) inline.set(full.contentId.replace(/[<>]/g, ''), `data:${a.contentType};base64,${full.contentBytes}`);
            else files.push(a);
          } catch {
            files.push(a);
          }
        }),
      );
      files = [...list.filter((a) => !a.isInline), ...files].map(({ name, size }) => ({ name, size }));
    } catch {}
  }
  const isHtml = m.body?.contentType === 'html';
  return {
    [isHtml ? 'html' : 'text']: m.body?.content || '',
    from: person(m.from),
    to: (m.toRecipients || []).map(person).join(', '),
    cc: (m.ccRecipients || []).map(person).join(', '),
    date: Date.parse(m.receivedDateTime) || 0,
    files,
    inline,
  };
}

// ---- Showing it --------------------------------------------------------------------------

const DROP = 'script, iframe, frame, frameset, object, embed, applet, form, input, button, select, textarea, link, meta, base, noscript, audio, video, source, track, portal';

// Email HTML made safe to show: no scripts or forms, links open in a new tab, and web
// pictures held back unless `images`. The frame's own policy enforces the same rules.
function clean(html, msg, images) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll(DROP)) el.remove();
  let blocked = 0;
  for (const el of doc.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'formaction' || n === 'ping') el.removeAttribute(name);
      else if (['href', 'src', 'xlink:href', 'action', 'background', 'poster'].includes(n) && /^\s*(javascript|vbscript|data:(?!image\/))/i.test(value)) el.removeAttribute(name);
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    const src = el.getAttribute('src') || el.getAttribute('background') || '';
    if (/^cid:/i.test(src)) {
      const data = msg.inline.get(src.slice(4).replace(/[<>]/g, ''));
      if (data) el.setAttribute(el.hasAttribute('src') ? 'src' : 'background', data);
      else el.remove();
    } else if (/^\s*(https?:)?\/\//i.test(src) && !images) {
      blocked++;
      el.removeAttribute('src');
      el.removeAttribute('background');
      if (el.tagName === 'IMG') el.setAttribute('alt', el.getAttribute('alt') || '');
    }
  }
  // Pictures set from style sheets count too; the frame's policy blocks those.
  if (!images && /url\(\s*['"]?\s*(https?:)?\/\//i.test(doc.documentElement.innerHTML)) blocked++;
  return { body: doc.body?.innerHTML || '', head: [...doc.querySelectorAll('style')].map((s) => s.outerHTML).join(''), blocked };
}

const linkify = (text) =>
  esc(text).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

function frameDoc(msg, images) {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? ' https: http:' : ''}`;
  const base = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank">
    <style>html{background:#fff;color:#1f2328}body{margin:0;padding:18px 22px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre.plain{margin:0;white-space:pre-wrap;font:inherit}a{color:#1a5fd0}</style>`;
  if (msg.html != null) {
    const { body, head, blocked } = clean(msg.html, msg, images);
    return { doc: `<!doctype html><html><head>${base}${head}</head><body>${body}</body></html>`, blocked };
  }
  return { doc: `<!doctype html><html><head>${base}</head><body><pre class="plain">${linkify(msg.text || '')}</pre></body></html>`, blocked: 0 };
}

const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const longDate = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

let current = null; // { item, msg, images, actions }

function paintBody() {
  const box = $('#rd-body');
  const { msg, images } = current;
  const { doc, blocked } = frameDoc(msg, images);
  const frame = document.createElement('iframe');
  frame.className = 'rd-frame';
  frame.title = 'Message';
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = doc;
  box.replaceChildren(frame);
  $('#rd-images').hidden = !blocked || images;
  const files = msg.files || [];
  $('#rd-files').innerHTML = files.length
    ? `<span class="rd-files-label">${files.length} attachment${files.length === 1 ? '' : 's'}:</span> ${files.map((f) => `<span class="rd-file">${esc(f.name)}${f.size ? ` <small>${size(f.size)}</small>` : ''}</span>`).join('')} <span class="rd-files-note">Open the email in ${esc(current.providerName)} to download.</span>`
    : '';
  $('#rd-files').hidden = !files.length;
  if (msg.to) $('#rd-to').textContent = `To ${msg.to}${msg.cc ? ` · Cc ${msg.cc}` : ''}`;
  if (msg.from) $('#rd-from').title = msg.from;
  if (msg.date) $('#rd-date').textContent = longDate(msg.date);
}

function paintStatus(html) {
  $('#rd-status').innerHTML = html;
  $('#rd-status').hidden = !html;
}

// Opens a message. `how` says where the full text comes from: 'gmail', 'outlook', or null when
// this account can't be read here (another Gmail account signed in to Chrome).
// `actions.change(action, { toast })` marks it read or deletes it and resolves to an undo.
export async function openReader({ item, how, clientId, providerUrl, providerName, account, letter, actions, autoRead }) {
  const dlg = $('#mail-dialog');
  current = { item, msg: null, images: false, providerName, undoRead: null, actions };
  dlg.innerHTML = `<article class="reader" aria-labelledby="rd-subject">
    <header class="rd-head">
      <div class="rd-titles">
        <h2 id="rd-subject">${esc(item.subject)}</h2>
        <p class="rd-meta"><span class="src" title="${esc(account)}">${esc(letter)}</span><strong id="rd-from">${esc(item.from)}</strong><span class="rd-date" id="rd-date">${esc(longDate(item.at))}</span></p>
        <p class="rd-to" id="rd-to"></p>
      </div>
      <button class="icon-btn" type="button" data-rd="close" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="rd-bar">
      <a class="btn small primary" href="${esc(providerUrl)}" target="_blank" rel="noopener">${icon('external')}Open in ${esc(providerName)}</a>
      ${actions ? `<button class="btn small" type="button" data-rd="read" id="rd-read">${icon('mail-open')}Mark as read</button><button class="btn small" type="button" data-rd="delete">${icon('trash')}Delete</button>` : ''}
      <span class="rd-state" id="rd-state"></span>
    </div>
    <p class="rd-status" id="rd-status" hidden></p>
    <p class="rd-images" id="rd-images" hidden>Pictures from the web are hidden, so the sender can’t tell you opened this. <button class="linklike" type="button" data-rd="images">Show pictures</button></p>
    <div class="rd-body" id="rd-body"><p class="quiet rd-loading">${how ? 'Opening the message…' : esc(item.snippet)}</p></div>
    <p class="rd-files" id="rd-files" hidden></p>
  </article>`;
  if (!dlg.open) dlg.showModal();
  $('[data-rd="close"]', dlg).focus();
  if (!how) {
    paintStatus(`This is the preview Gmail’s feed gives. Daybook can open whole messages for the Google account connected in Settings; for ${esc(account)}, use Open in Gmail.`);
    return;
  }
  const mine = current;
  try {
    const key = `${how}:${item.msgId || item.id}`;
    const msg = loaded.get(key) || (how === 'gmail' ? await gmailMessage(item.msgId) : await outlookMessage(clientId, item.id));
    loaded.set(key, msg);
    if (current !== mine || !dlg.open) return;
    current.msg = msg;
    paintBody();
  } catch (err) {
    if (current !== mine) return;
    $('#rd-body').innerHTML = `<p class="quiet rd-loading">${esc(item.snippet)}</p>`;
    paintStatus(`Couldn’t open the whole message: ${esc(reason(err))}. Here is the preview; Open in ${esc(providerName)} shows the rest.`);
    return;
  }
  // Opening an email here counts as reading it, as it would in Gmail or Outlook.
  if (actions && autoRead) {
    const undo = await actions.change('read', { toast: false });
    if (current !== mine) return;
    if (undo) {
      current.undoRead = undo;
      $('#rd-read').hidden = true;
      $('#rd-state').innerHTML = `Marked as read <button class="linklike" type="button" data-rd="unread">Keep unread</button>`;
    }
  }
}

export function initReader() {
  const dlg = $('#mail-dialog');
  if (!dlg) return;
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) return dlg.close();
    const b = e.target.closest('[data-rd]');
    if (!b || !current) return;
    const what = b.dataset.rd;
    if (what === 'close') dlg.close();
    else if (what === 'images') {
      current.images = true;
      paintBody();
    } else if (what === 'unread' && current.undoRead) {
      const undo = current.undoRead;
      current.undoRead = null;
      $('#rd-state').textContent = 'Kept unread';
      try {
        await undo();
      } catch (err) {
        $('#rd-state').textContent = `Couldn’t keep it unread: ${reason(err)}.`;
      }
    } else if ((what === 'read' || what === 'delete') && current.actions) {
      const { actions } = current;
      dlg.close();
      actions.change(what, { toast: true });
    }
  });
  dlg.addEventListener('close', () => {
    $('#rd-body', dlg)?.replaceChildren();
    current = null;
  });
}
