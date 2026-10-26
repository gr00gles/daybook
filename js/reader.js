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

// The parts you read, in order: the richest version inside each multipart/alternative, every
// text part of a multipart/mixed (Apple Mail puts text after attachments), and a forwarded
// message (message/rfc822) only when the email has no text of its own.
function bodyParts(part) {
  const type = (part.mimeType || '').toLowerCase();
  if (part.filename || /^\s*attachment/i.test(headerOf(part, 'content-disposition'))) return [];
  if (type === 'text/html' || type === 'text/plain') return [part];
  const kids = part.parts || [];
  if (type === 'multipart/alternative') {
    for (const want of ['text/html', 'text/plain'])
      for (const k of [...kids].reverse()) {
        const got = bodyParts(k);
        if (got.some((p) => p.mimeType.toLowerCase() === want)) return got;
      }
    return [];
  }
  if (type === 'message/rfc822') return kids.flatMap(bodyParts);
  if (type.startsWith('multipart/')) {
    const own = kids.filter((k) => (k.mimeType || '').toLowerCase() !== 'message/rfc822').flatMap(bodyParts);
    return own.length ? own : kids.flatMap(bodyParts);
  }
  return [];
}

// Attachments, and pictures that may be shown inside the message (some have no file name).
function fileParts(part, out = []) {
  const type = (part.mimeType || '').toLowerCase();
  const cid = headerOf(part, 'content-id').replace(/[<>]/g, '').toLowerCase();
  if (part.filename || (type.startsWith('image/') && (cid || part.body?.attachmentId))) {
    out.push({ name: part.filename || `picture.${type.split('/')[1] || 'img'}`, size: part.body?.size || 0, type, id: part.body?.attachmentId, data: part.body?.data, cid });
  } else for (const p of part.parts || []) fileParts(p, out);
  return out;
}

// The cid: pictures an HTML body actually shows.
const cidRefs = (html) => new Set([...(html || '').matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1].replace(/[<>]/g, '').toLowerCase()));

async function partText(msgId, part) {
  let data = part.body?.data;
  // Long bodies come separately, like attachments.
  if (!data && part.body?.attachmentId) data = (await gmailApi(`/messages/${msgId}/attachments/${part.body.attachmentId}`, { method: 'GET' })).data;
  return data ? decodeText(data, headerOf(part, 'content-type')) : '';
}

async function gmailMessage(msgId) {
  const m = await gmailApi(`/messages/${encodeURIComponent(msgId)}?format=full`, { method: 'GET' });
  const payload = m.payload || {};
  const pieces = await Promise.all(bodyParts(payload).map(async (p) => ({ html: p.mimeType.toLowerCase() === 'text/html', text: await partText(msgId, p) })));
  const body = pieces.some((p) => p.html)
    ? { html: pieces.map((p) => (p.html ? p.text : `<pre class="plain">${linkify(p.text)}</pre>`)).join('\n') }
    : { text: pieces.map((p) => p.text).join('\n\n') || m.snippet || '' };
  // Pictures the message shows inside itself (logos, signatures): small ones. Everything
  // else is listed as an attachment, Content-ID or not.
  const files = fileParts(payload);
  const refs = cidRefs(body.html);
  const inline = new Map();
  const pics = files.filter((f) => f.cid && refs.has(f.cid) && f.type.startsWith('image/') && f.size < 1.5e6).slice(0, 10);
  await Promise.all(
    pics.map(async (f) => {
      try {
        const data = f.data || (await gmailApi(`/messages/${msgId}/attachments/${f.id}`, { method: 'GET' })).data;
        if (data) inline.set(f.cid, `data:${f.type};base64,${toStdB64(data)}`);
      } catch {}
    }),
  );
  const h = (n) => headerOf(payload, n);
  return {
    ...body,
    from: h('from'),
    to: h('to'),
    cc: h('cc'),
    date: Number(m.internalDate) || Date.parse(h('date')) || 0,
    files: files.filter((f) => !(f.cid && refs.has(f.cid))).map(({ name, size }) => ({ name, size })),
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
  const isHtml = m.body?.contentType === 'html';
  const refs = cidRefs(isHtml ? m.body?.content : '');
  // hasAttachments leaves out pictures inside the message, so look whenever the body shows one.
  if (m.hasAttachments || refs.size) {
    try {
      const list = (await graph(clientId, `${base}/attachments?$select=id,name,size,isInline,contentType`)).value || [];
      const pics = list.filter((a) => a.isInline && /^image\//.test(a.contentType || '') && a.size < 1.5e6).slice(0, 10);
      await Promise.all(
        pics.map(async (a) => {
          try {
            const full = await graph(clientId, `${base}/attachments/${encodeURIComponent(a.id)}`);
            const cid = (full.contentId || '').replace(/[<>]/g, '').toLowerCase();
            if (cid && full.contentBytes && refs.has(cid)) inline.set(cid, `data:${a.contentType};base64,${full.contentBytes}`);
          } catch {}
        }),
      );
      files = list.filter((a) => !a.isInline).map(({ name, size }) => ({ name, size }));
    } catch {}
  }
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

// Elements that never show in a message, and those whose content parses differently the
// second time round (which is how sanitizers get fooled).
const DROP =
  'script, iframe, frame, frameset, object, embed, applet, form, input, button, select, textarea, link, meta, base, noscript, audio, video, source, track, portal, template, math, svg, xmp, noembed, noframes, plaintext, listing, title';
const ROOT_ATTRS = ['dir', 'lang', 'bgcolor', 'text', 'link', 'vlink', 'alink', 'style', 'background', 'class'];

function cleanOnce(html, msg, images) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll(DROP)) el.remove();
  const styles = [...doc.querySelectorAll('style')].map((st) => {
    st.remove();
    return `<style>${st.textContent}</style>`;
  });
  let blocked = 0;
  for (const el of [doc.documentElement, ...doc.querySelectorAll('*')]) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'formaction' || n === 'ping') el.removeAttribute(name);
      else if (['href', 'src', 'xlink:href', 'action', 'background', 'poster'].includes(n) && /^\s*(javascript|vbscript|data:(?!image\/))/i.test(value)) el.removeAttribute(name);
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    for (const attr of ['src', 'background']) {
      const src = el.getAttribute(attr);
      if (!src) continue;
      if (/^\s*cid:/i.test(src)) {
        const data = msg.inline.get(src.trim().slice(4).replace(/[<>]/g, '').toLowerCase());
        if (data) el.setAttribute(attr, data);
        // A picture that can't be found goes; a table cell or body with a missing background stays.
        else if (el.tagName === 'IMG') el.remove();
        else el.removeAttribute(attr);
      } else if (/^\s*(https?:)?\/\//i.test(src) && !images) {
        blocked++;
        el.removeAttribute(attr);
      }
    }
  }
  // Pictures set from style sheets count too; the frame's policy blocks those.
  if (!images && /url\(\s*['"]?\s*(https?:)?\/\//i.test(styles.join('') + (doc.documentElement.outerHTML || ''))) blocked++;
  const attrs = (el) =>
    el ? [...el.attributes].filter((a) => ROOT_ATTRS.includes(a.name.toLowerCase())).map((a) => ` ${a.name.toLowerCase()}="${esc(a.value)}"`).join('') : '';
  return { head: styles.join(''), body: doc.body?.innerHTML || '', htmlAttrs: attrs(doc.documentElement), bodyAttrs: attrs(doc.body), blocked };
}

const compose = (c) => `<html${c.htmlAttrs}><head>${c.head}</head><body${c.bodyAttrs}>${c.body}</body></html>`;

// Email HTML made safe to show: no scripts, forms or outside links to other resources, links
// open in a new tab, and web pictures held back unless `images`. The result is cleaned again
// until parsing it changes nothing, so what the frame parses is exactly what was checked.
// Null if it never settles.
function clean(html, msg, images) {
  let c = cleanOnce(html, msg, images);
  const { blocked } = c;
  for (let round = 0; round < 3; round++) {
    const s = compose(c);
    const again = cleanOnce(s, msg, images);
    if (compose(again) === s) return { ...c, blocked };
    c = again;
  }
  return null;
}

function linkify(text) {
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += `${esc(text.slice(last, m.index))}<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function frameDoc(msg, images) {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? ' https: http:' : ''}`;
  const base = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><base target="_blank">
    <style>html{background:#fff;color:#1f2328}body{margin:0;padding:18px 22px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre.plain{margin:0;white-space:pre-wrap;font:inherit}a{color:#1a5fd0}</style>`;
  const c = msg.html != null ? clean(msg.html, msg, images) : null;
  if (c) return { doc: `<!doctype html><html${c.htmlAttrs}><head>${base}${c.head}</head><body${c.bodyAttrs}>${c.body}</body></html>`, blocked: c.blocked };
  // Plain text, or HTML too tangled to show safely: show its words.
  const text = msg.html != null ? new DOMParser().parseFromString(msg.html, 'text/html').body?.innerText || '' : msg.text || '';
  return { doc: `<!doctype html><html><head>${base}</head><body><pre class="plain">${linkify(text)}</pre></body></html>`, blocked: 0 };
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
// `actions.change(action, { toast })` marks it read, junks or deletes it and resolves to an undo.
export async function openReader({ item, how, clientId, providerUrl, providerName, account, mark, actions, autoRead }) {
  const dlg = $('#mail-dialog');
  current = { item, msg: null, images: false, providerName, undoRead: null, actions };
  dlg.innerHTML = `<article class="reader" aria-labelledby="rd-subject">
    <header class="rd-head">
      <div class="rd-titles">
        <h2 id="rd-subject">${esc(item.subject)}</h2>
        <p class="rd-meta"><span class="src" title="${esc(account)}">${mark}</span><strong id="rd-from">${esc(item.from)}</strong><span class="rd-date" id="rd-date">${esc(longDate(item.at))}</span></p>
        <p class="rd-to" id="rd-to"></p>
      </div>
      <button class="icon-btn" type="button" data-rd="close" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="rd-bar">
      <a class="btn small primary" href="${esc(providerUrl)}" target="_blank" rel="noopener">${icon('external')}Open in ${esc(providerName)}</a>
      ${actions ? `<button class="btn small" type="button" data-rd="read" id="rd-read">${icon('mail-open')}Mark as read</button><button class="btn small" type="button" data-rd="junk">${icon('junk')}Junk</button><button class="btn small" type="button" data-rd="delete">${icon('trash')}Delete</button>` : ''}
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
    try {
      const undo = await actions.change('read', { toast: false });
      if (current !== mine || !undo) return;
      current.undoRead = undo;
      $('#rd-read').hidden = true;
      $('#rd-state').innerHTML = `Marked as read <button class="linklike" type="button" data-rd="unread">Keep unread</button>`;
    } catch (err) {
      if (current === mine) $('#rd-state').textContent = `Couldn’t mark it as read: ${reason(err)}.`;
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
        const read = $('#rd-read');
        if (read) read.hidden = false;
      } catch (err) {
        $('#rd-state').textContent = `Couldn’t keep it unread: ${reason(err)}.`;
      }
    } else if ((what === 'read' || what === 'junk' || what === 'delete') && current.actions) {
      const { actions } = current;
      dlg.close();
      actions.change(what, { toast: true });
    }
  });
  dlg.addEventListener('close', () => {
    $('#rd-body', dlg)?.replaceChildren();
    current = null;
    // The row that opened it may be gone (read messages leave the list): land in the list.
    if (!document.activeElement || document.activeElement === document.body) ($('#mail-body a.mail') || $('#mail-body'))?.focus?.({ preventScroll: true });
  });
}
