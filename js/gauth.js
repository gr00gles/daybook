// Google sign-in through Chrome's own account (chrome.identity.getAuthToken). Chrome keeps
// the token fresh, so after the one-time consent nobody is asked again.
import { local } from './util.js';

const KEY = 'google:account';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
// Asked for the first time someone marks Gmail read or deletes it.
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
// Asked when someone turns on the YouTube card.
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

export class NeedsGoogle extends Error {
  constructor(message = 'Google is not connected') {
    super(message);
    this.code = 'needs-google';
  }
}

export const googleConfigured = () => Boolean(chrome.runtime.getManifest?.().oauth2?.client_id);

export const googleAccount = () => local.get(KEY);

// Chrome reports failures as plain messages; turn the common ones into plain English.
function explain(err) {
  const m = String(err?.message || err);
  if (/not signed in/i.test(m)) return 'Chrome sign-in was cancelled. Try again and sign in to Chrome with your Google account.';
  if (/did not approve|access_denied|canceled|cancelled/i.test(m)) return 'Google sign-in was cancelled.';
  if (/turned off browser signin/i.test(m)) return 'Chrome sign-in is turned off on this computer, so Google can’t connect. Turn on “Allow Chrome sign-in” in Chrome settings.';
  if (/incognito/i.test(m)) return 'Google can’t connect in an incognito window.';
  if (/bad client id|invalid_client|deleted_client/i.test(m)) return 'This copy of Daybook has an invalid Google app ID. Ask the person who shared it for a new copy.';
  return m;
}

async function token(interactive) {
  try {
    const r = await chrome.identity.getAuthToken({ interactive });
    const t = typeof r === 'string' ? r : r?.token;
    if (!t) throw new Error('No token');
    if (r?.grantedScopes && !r.grantedScopes.includes(CALENDAR_SCOPE)) {
      // Forget this partial grant so the next attempt shows Google's consent screen again.
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
      await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
      throw new NeedsGoogle('Daybook needs permission to see your calendar. Connect Google again and leave the calendar box ticked.');
    }
    return t;
  } catch (err) {
    if (err instanceof NeedsGoogle) throw err;
    if (interactive) throw new Error(explain(err));
    throw new NeedsGoogle('Google sign-in expired');
  }
}

export async function connectGoogle() {
  const t = await token(true);
  const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${t}` } }).then((r) =>
    r.ok ? r.json() : {},
  );
  const account = { email: me.email || '', name: me.name || '', givenName: me.given_name || '' };
  await local.set(KEY, account);
  return account;
}

export async function disconnectGoogle() {
  const t = await chrome.identity
    .getAuthToken({ interactive: false })
    .then((r) => (typeof r === 'string' ? r : r?.token))
    .catch(() => null);
  if (t) {
    // Revoke the grant itself, not just Chrome's cached copy, so "Connect" asks again.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
    await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
  }
  // YouTube's terms require deleting its data once access is removed.
  await local.remove([KEY, 'cache:gcal', 'cache:gcal-list', 'yt:subs', 'yt:feed']);
}

export async function gapi(path) {
  if (!(await googleAccount())) throw new NeedsGoogle();
  const url = `https://www.googleapis.com${path}`;
  let t = await token(false);
  let res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
    t = await token(false);
    res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  }
  if (res.status === 401) throw new NeedsGoogle('Google sign-in expired');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason || j.error?.status || '';
    if (/insufficientPermissions|PERMISSION_DENIED/i.test(reason) && res.status === 403 && !/accessNotConfigured|SERVICE_DISABLED/i.test(JSON.stringify(j)))
      throw new NeedsGoogle('Daybook needs permission to see your calendar. Connect Google again and leave the calendar box ticked.');
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(JSON.stringify(j)))
      throw new Error('The Google Calendar API is turned off for this copy of Daybook. The person who shared it needs to enable it in Google Cloud.');
    throw new Error(j.error?.message || `Google returned ${res.status}`);
  }
  return res.json();
}

// A token for one extra permission, asked for the first time a feature needs it.
async function scopedToken(scope, interactive, what) {
  const r = await chrome.identity.getAuthToken({ interactive, scopes: [scope] });
  const t = typeof r === 'string' ? r : r?.token;
  if (!t) throw new Error('No token');
  if (r?.grantedScopes && !r.grantedScopes.includes(scope)) {
    await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
    throw new Error(`Daybook needs permission to ${what}. Try again and leave that box ticked.`);
  }
  return t;
}

const gmailToken = (interactive) => scopedToken(GMAIL_SCOPE, interactive, 'manage your Gmail');

// Gmail API calls for the Google account connected in Daybook. The first call opens Google's
// consent window for the gmail.modify permission; with quiet it never does and fails instead.
export async function gmailApi(path, { method = 'POST', body, quiet = false } = {}) {
  let t;
  try {
    t = await gmailToken(false);
  } catch {
    if (quiet) throw new NeedsGoogle('Gmail permission not granted');
    try {
      t = await gmailToken(true);
    } catch (err) {
      throw new Error(explain(err));
    }
  }
  const call = (tok) =>
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await call(t);
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
    t = await gmailToken(false);
    res = await call(t);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(JSON.stringify(j)))
      throw new Error('The Gmail API is turned off for this copy of Daybook. The person who shared it needs to enable it in Google Cloud');
    throw new Error(j.error?.message || `Gmail returned ${res.status}`);
  }
  return j;
}

// YouTube Data API calls. Background refreshes never pop up a window: they report
// NeedsGoogle and the card offers a button, whose click passes interactive: true.
export async function youtubeApi(path, { interactive = false } = {}) {
  const get = (tok) => fetch(`https://www.googleapis.com/youtube/v3${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  let t;
  try {
    t = await scopedToken(YOUTUBE_SCOPE, interactive, 'see your YouTube subscriptions');
  } catch (err) {
    if (interactive) throw new Error(explain(err));
    throw new NeedsGoogle('YouTube isn’t connected yet');
  }
  let res = await get(t);
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: t }).catch(() => {});
    t = await scopedToken(YOUTUBE_SCOPE, false, 'see your YouTube subscriptions');
    res = await get(t);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = JSON.stringify(j);
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(text))
      throw new Error('The YouTube API is turned off for this copy of Daybook. The person who shared it needs to enable “YouTube Data API v3” in Google Cloud');
    if (/quotaExceeded|dailyLimitExceeded/i.test(text)) throw new Error('YouTube’s daily limit for this copy of Daybook is used up. It resets at midnight Pacific time');
    if (/youtubeSignupRequired|channelNotFound/i.test(text)) throw new Error('This Google account doesn’t have a YouTube channel, so it has no subscriptions to show');
    throw new Error(j.error?.message || `YouTube returned ${res.status}`);
  }
  return j;
}
