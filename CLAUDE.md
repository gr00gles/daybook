# Daybook

Unpacked Manifest V3 Chrome extension that replaces the new tab page. The repository root is the extension folder: the owner loads it with "Load unpacked" from a GitHub Desktop clone and updates by pulling.

- Bump `version` in manifest.json on every change. A new tab compares the version on disk with the running one and offers "Finish update" (chrome.runtime.reload) when they differ.
- Never change `key` in manifest.json: the Google OAuth client (oauth2.client_id) and the Microsoft app (config.js, SPA redirect https://flgomcdbgonicihokfkbpopedcilcpdn.chromiumapp.org/) are bound to the extension ID it fixes.
- No build step and no remote code: plain ES modules in js/, fonts in fonts/, ical.js in lib/. Extension CSP forbids inline scripts and event-handler attributes.
- Gmail is read from the cookie-authenticated Atom feed in background.js; Google Calendar through chrome.identity.getAuthToken; Outlook through Microsoft Graph with auth code + PKCE (js/msauth.js).
- Keep personal data out of the code; each user's settings live in chrome.storage.
