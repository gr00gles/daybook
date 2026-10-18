// Gmail's feed is fetched here instead of in the new tab page. When an account is signed
// out, Gmail can answer with an HTTP auth challenge, which in a page would pop up a
// username/password dialog; a service worker has no window to show one in.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'gmail-feed') return;
  if (!/^https:\/\/mail\.google\.com\/mail\/u\/\d+\/feed\/atom\//.test(msg.url)) return;
  fetch(msg.url, { credentials: 'include', cache: 'no-store' })
    .then(async (res) =>
      reply({ ok: true, status: res.status, url: res.url, redirected: res.redirected, text: res.ok ? await res.text() : '' }),
    )
    .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
  return true;
});
