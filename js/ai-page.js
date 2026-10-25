// Runs on claude.ai, chatgpt.com and gemini.google.com. Two jobs:
// - A question from the new tab can come after # in the link: #daybook-q= types it in and sends
//   it (Gemini's site takes no question in its link), #daybook-draft= types it in and leaves it
//   for you to send (a follow-up, opened on the conversation it follows).
// - Inside the answer box on Daybook's new tab, it tells the page which conversation is showing,
//   so a follow-up can open that conversation.
// Other visits to these sites are left alone.
(() => {
  const m = location.hash.match(/^#daybook-(q|draft)=(.*)$/s);
  if (m) {
    let q = '';
    try {
      q = decodeURIComponent(m[2]).trim();
    } catch {}
    history.replaceState(history.state, '', location.pathname + location.search);
    if (q) fill(q, m[1] === 'q');
  }
  if (location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`) report();

  function fill(q, send) {
    const until = Date.now() + 20000;
    const later = (f) => Date.now() < until && setTimeout(f, 200);
    const press = () => {
      const b = document.querySelector('button[data-testid="send-button"], button.send-button, button[aria-label*="send" i]');
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
      else later(press);
    };
    const type = () => {
      const box = document.querySelector('#prompt-textarea, rich-textarea [contenteditable="true"], div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea');
      if (!box) return later(type);
      box.focus();
      if (box.tagName === 'TEXTAREA') {
        box.value = q;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, q);
      }
      if (send) setTimeout(press, 150);
    };
    type();
  }

  // The address as the conversation moves from a new chat to its own page.
  function report() {
    let last = '';
    const tell = () => {
      if (location.href === last) return;
      last = location.href;
      chrome.runtime.sendMessage({ type: 'ai-page', url: location.href }).catch(() => {});
    };
    tell();
    setInterval(tell, 700);
  }
})();
