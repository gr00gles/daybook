// Runs on an Amazon order's details page that Daybook opens out of sight, in a frame on the new
// tab page (amazon.js). It hands Daybook the names of the items in the order: the words of the
// links to their product pages. The page also shows other products ("Customers also bought" and
// the like), in carousels and with links Amazon tags differently: the order's own links carry a
// ref starting "ppx". On an order page you open yourself it does nothing.
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
  const NOT_NAME = /^(?:buy|view|write|return|replace|track|share|get|leave|ask|problem|archive|cancel|see|your|add|shop|support|typical|list price|was|save|only)\b|^\$|\$\s?\d|out of 5 stars/i;
  const PRODUCT = /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/;
  // Where Amazon puts products other than the order's.
  const ELSEWHERE = 'nav, header, footer, [role="navigation"], .a-carousel-container, .a-carousel, [data-a-carousel-options], [class*="carousel" i], [id*="carousel" i], [class*="p13n" i], [id*="p13n" i], [id*="rhf" i], [class*="sims" i], [cel_widget_id*="sims" i]';
  const OTHER_REF = /p13n|sims|^pd_|rhf|sbs|bia|^ci_|^dp_|recs?_/i;
  const refOf = (href) => href.match(/(?:\/ref=|[?&]ref_?=)([^/?&#]+)/)?.[1] || '';
  const started = Date.now();

  const namesIn = (links) => {
    const out = [];
    for (const a of links) {
      for (const t of [a.textContent, a.querySelector('img[alt]')?.getAttribute('alt')]) {
        const name = clean(t);
        if (name.length < 8 || name.length > 300 || !/\s/.test(name) || NOT_NAME.test(name)) continue;
        // A shortened title of one already found ("… Wall/Cei"), or the other way round.
        const at = out.findIndex((x) => x.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(x.toLowerCase()));
        if (at < 0) out.push(name);
        else if (name.length > out[at].length) out[at] = name;
      }
    }
    return out;
  };
  const names = () => {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => PRODUCT.test(a.getAttribute('href') || ''));
    // The order's own links; failing those, product links away from Amazon's other products.
    const own = links.filter((a) => /^ppx/i.test(refOf(a.getAttribute('href'))));
    return namesIn(own.length ? own : links.filter((a) => !a.closest(ELSEWHERE) && !OTHER_REF.test(refOf(a.getAttribute('href')))));
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
