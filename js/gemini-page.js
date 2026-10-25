// Runs on gemini.google.com. Gemini's site has no way to take a question in its link, so a
// question asked from the new tab comes after #daybook-q= and is typed into the prompt box here,
// then sent. Other visits to Gemini are left alone.
(() => {
  const m = location.hash.match(/^#daybook-q=(.*)$/s);
  if (!m) return;
  let q;
  try {
    q = decodeURIComponent(m[1]).trim();
  } catch {
    return;
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!q) return;
  const until = Date.now() + 20000;
  const later = (f) => Date.now() < until && setTimeout(f, 200);
  const send = () => {
    const b = document.querySelector('button.send-button, button[aria-label*="send" i]');
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
    else later(send);
  };
  const type = () => {
    const box = document.querySelector('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]');
    if (!box) return later(type);
    box.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, q);
    setTimeout(send, 150);
  };
  type();
})();
