// Runs in Gmail's own page when Daybook opens it out of sight, in a frame on the new tab page
// (shipmail.js), with a search for shipping emails. It waits for the search results, then opens
// each conversation's printable page, the plain one Gmail's Print button shows, with the same
// sign-in, and hands Daybook the emails in full: who sent each, when, and the email itself.
// Nothing is changed in the mailbox. In a Gmail tab you open yourself it does nothing.
(() => {
  if (window === window.top || location.ancestorOrigins?.[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  const base = location.pathname.match(/^\/mail\/u\/\d+\//)?.[0];
  if (!base) return;
  const MAX = 20; // conversations read in full each time
  const started = Date.now();
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // "Wed, Apr 8, 2026, 2:20 PM" and "Wed, Apr 8, 2026 at 2:20 PM", as a time.
  const timeOf = (s) => Date.parse(clean(s).replace(/\s+at\s+/i, ' ').replace(/,(\s*\d{1,2}:\d{2})/, '$1').replace(/[  ]/g, ' ')) || 0;

  // The key Gmail's own Print button puts in its links. It sits in the page's start-up data
  // (GLOBALS[9]); links already on the page carry it too.
  function printKey() {
    for (const s of document.scripts) {
      const t = s.textContent;
      const at = t.indexOf('GLOBALS=[');
      if (at < 0) continue;
      // The array's first ten entries, stepping over strings and anything nested.
      const items = [];
      let depth = 0;
      let from = at + 'GLOBALS=['.length;
      for (let i = from; i < t.length && items.length < 10; i++) {
        const c = t[i];
        if (c === '"' || c === "'") {
          for (i++; i < t.length && t[i] !== c; i++) if (t[i] === '\\') i++;
        } else if (c === '[' || c === '{') depth++;
        else if ((c === ']' || c === '}') && depth) depth--;
        else if ((c === ',' || c === ']') && !depth) {
          items.push(t.slice(from, i).trim());
          from = i + 1;
          if (c === ']') break;
        }
      }
      const ik = items[9]?.replace(/^["']|["']$/g, '');
      if (/^[0-9a-f]{6,16}$/i.test(ik || '')) return ik;
    }
    return document.documentElement.innerHTML.match(/[?&]ik=([0-9a-f]{6,16})\b/i)?.[1] || '';
  }

  const account = () => (document.title.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0].toLowerCase();

  // The conversations in the search results now showing.
  function rows() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[role="main"] [data-legacy-thread-id], [role="main"] [data-thread-id]')) {
      if (!el.getClientRects().length) continue; // another view, kept in the page but hidden
      const hex = el.getAttribute('data-legacy-thread-id') || '';
      const dec = (el.getAttribute('data-thread-id') || '').match(/(\d{6,})$/)?.[1] || (hex ? BigInt(`0x${hex}`).toString() : '');
      if (!dec || seen.has(dec)) continue;
      seen.add(dec);
      const row = el.closest('tr') || el.parentElement;
      const who = row?.querySelector('[email]');
      // The date column's full date, or failing that any full date the row carries.
      const when = [...(row?.querySelectorAll('.xW [title], [title]') || [])].map((t) => timeOf(t.getAttribute('title'))).find(Boolean);
      out.push({
        hex: hex || BigInt(dec).toString(16),
        dec,
        lastId: el.getAttribute('data-legacy-last-message-id') || '',
        subject: clean(el.textContent),
        snippet: clean(row?.querySelector('.y2')?.textContent).replace(/^[-–—]\s*/, ''),
        from: who?.getAttribute('name') || clean(who?.textContent) || '',
        fromAddr: who?.getAttribute('email') || '',
        at: when || 0,
        unread: Boolean(row?.matches?.('.zE')),
      });
    }
    return out;
  }

  // Search results fill in after the page loads: wait until the same ones show twice running.
  async function results() {
    let last = '';
    while (Date.now() - started < 35000) {
      await sleep(1500);
      const list = rows();
      const key = list.map((r) => r.dec).join();
      if (list.length && key === last) return list;
      // A search with no results never shows rows; past a while, that's the answer.
      if (!list.length && document.querySelector('[role="main"]') && Date.now() - started > 15000) return [];
      last = key;
    }
    return rows();
  }

  // One conversation's printable page: its subject and each email in it.
  async function printed(r, ik) {
    const q = new URLSearchParams({ view: 'pt', search: 'all' });
    if (ik) q.set('ik', ik);
    q.set('permthid', `thread-f:${r.dec}`);
    q.set('th', r.hex);
    const res = await fetch(`${base}?${q}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const tables = [...doc.querySelectorAll('table.message')].slice(-3); // the newest few in a long one
    if (!tables.length) return null;
    const subject = clean(doc.querySelector('.maincontent font[size="+1"]')?.textContent) || clean(doc.title.replace(/^Gmail\s*-\s*/i, ''));
    const messages = tables.map((t) => {
      const head = t.rows[0];
      const fromText = clean(head?.cells[0]?.textContent);
      const fromAddr = fromText.match(/<([^>\s]+@[^>\s]+)>/)?.[1] || fromText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] || '';
      const body = t.querySelector('div[style*="overflow"]') || t.rows[t.rows.length - 1];
      for (const el of body?.querySelectorAll('style, script, head, title, meta, link') || []) el.remove();
      return {
        from: clean(head?.cells[0]?.querySelector('b')?.textContent) || fromText.replace(/<[^>]*>/, '').trim() || fromAddr,
        fromAddr,
        at: timeOf(head?.cells[head.cells.length - 1]?.textContent),
        html: (body?.innerHTML || '').slice(0, 300000),
      };
    });
    return { subject, messages };
  }

  (async () => {
    const list = (await results()).slice(0, MAX);
    const ik = printKey();
    const threads = [];
    // A few at a time, so the reading doesn't take long.
    for (let i = 0; i < list.length; i += 4) {
      const got = await Promise.all(list.slice(i, i + 4).map((r) => printed(r, ik).catch(() => null)));
      got.forEach((p, j) => threads.push({ ...list[i + j], subject: p?.subject || list[i + j].subject, messages: p?.messages || [] }));
    }
    chrome.runtime.sendMessage({ type: 'gmail-page', base, email: account(), printKey: Boolean(ik), threads });
  })();
})();
