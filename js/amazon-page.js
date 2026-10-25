// Runs on an Amazon order's details page that Daybook opens out of sight, in a frame on the new
// tab page (amazon.js). It hands Daybook the names of the items in the order: the words of the
// links to their product pages. On an order page you open yourself it does nothing.
(() => {
  if (window === window.top || location.ancestorOrigins?.[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  const order = new URLSearchParams(location.search).get('orderID') || '';
  // Amazon asks for a sign-in instead of showing the order.
  if (/\/ap\/(?:signin|mfa|cvf)/.test(location.pathname)) {
    chrome.runtime.sendMessage({ type: 'amazon-order', order, signedOut: true });
    return;
  }
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // Links to a product that aren't its name: "Buy it again", "Write a product review" and so on.
  const NOT_NAME = /^(?:buy|view|write|return|replace|track|share|get|leave|ask|problem|archive|cancel|see|your|add|shop|support)\b/i;
  const PRODUCT = /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/;
  const started = Date.now();

  const names = () => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (!PRODUCT.test(a.getAttribute('href') || '') || a.closest('nav, header, footer, [role="navigation"]')) continue;
      for (const t of [a.textContent, a.querySelector('img[alt]')?.getAttribute('alt')]) {
        const name = clean(t);
        if (name.length >= 8 && name.length <= 300 && /\s/.test(name) && !NOT_NAME.test(name) && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
      }
    }
    return out;
  };

  // The page may fill in after it loads: look a few times, for up to 15 seconds.
  const check = () => {
    const found = names();
    if (found.length || Date.now() - started > 15000) {
      chrome.runtime.sendMessage({ type: 'amazon-order', order, items: found.slice(0, 8) });
      return;
    }
    setTimeout(check, 1000);
  };
  setTimeout(check, 800);
})();
