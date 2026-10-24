// Runs on carrier tracking pages that Daybook opens out of sight, in a frame on the new tab page
// (tracking.js). It waits for the page to show the package's status, then hands Daybook the
// likeliest status headline (the biggest, boldest status words, not the small steps of a
// progress bar), the lines about the delivery day, and some of the page's text. On a tracking
// page you open yourself it does nothing.
(() => {
  if (window === window.top || location.ancestorOrigins?.[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  const STATUS =
    /deliver|out for delivery|in transit|on the way|on its way|label created|information received|pre-shipment|exception|delay|attempt|arriv|picked up|pick ?up|departed|accepted|processed|returned|moving through/i;
  const DATES = /(?:estimated|expected|scheduled|anticipated|projected|new)\s+delivery|delivered\s+on|delivery date|arriving/i;
  const started = Date.now();
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // An element's own words: its text, or for a box with children, the text right inside it.
  const own = (el) => clean(el.children.length ? [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ') : el.textContent);
  const score = (c) => c.size * 2 + (c.weight >= 600 ? 4 : 0) + (c.current ? 8 : 0) - c.top / 300;

  function look() {
    const found = [];
    const dates = [];
    for (const el of document.body?.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, strong, b, td, th, li, dt, dd, label') || []) {
      if (el.closest('nav, footer, header, [role="navigation"], [role="banner"], [role="contentinfo"], script, style, noscript')) continue;
      const text = own(el);
      if (!text || text.length > 140) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const css = getComputedStyle(el);
      if (STATUS.test(text)) {
        found.push({
          text,
          size: parseFloat(css.fontSize) || 0,
          weight: Number(css.fontWeight) || 400,
          top: box.top + scrollY,
          current: Boolean(el.closest('[aria-current], [class*="current" i], [class*="active" i]')),
        });
      }
      // The words after a "delivery" label are often in the next element or the parent.
      if (DATES.test(text)) dates.push(clean(`${text} ${el.nextElementSibling?.textContent || ''} ${text.length < 40 ? el.parentElement?.textContent || '' : ''}`).slice(0, 200));
    }
    found.sort((a, b) => score(b) - score(a));
    return { found: found.slice(0, 8), dates: dates.slice(0, 8) };
  }

  // Pages fill in after they load: wait until the best headline holds still for two looks.
  let last = '';
  const check = () => {
    const seen = look();
    const top = seen.found[0]?.text || '';
    if ((top && top === last) || Date.now() - started > 25000) {
      chrome.runtime.sendMessage({ type: 'track-page', ...seen, text: clean(document.body?.innerText).slice(0, 5000) });
      return;
    }
    last = top;
    setTimeout(check, 1200);
  };
  setTimeout(check, 1500);
})();
