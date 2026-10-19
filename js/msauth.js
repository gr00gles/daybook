// Microsoft sign-in for Outlook mail and calendar: OAuth authorization code + PKCE through
// chrome.identity, against the app registration named in config.js.
import { local } from './util.js';

const LOGIN = 'https://login.microsoftonline.com';
const COMMON = `${LOGIN}/common/oauth2/v2.0`;
// After the first sign-in, talk to the account's own tenant: /common with prompt=none fails
// when several Microsoft accounts are signed in.
const authorityFor = (hint) =>
  hint?.personal ? `${LOGIN}/consumers/oauth2/v2.0` : hint?.tid ? `${LOGIN}/${hint.tid}/oauth2/v2.0` : COMMON;
const SCOPE = 'openid profile offline_access User.Read Mail.Read Calendars.Read';
// Extra permissions, each asked for the first time a feature needs it: Mail.ReadWrite to mark
// mail read or delete it, Calendars.ReadWrite to add events. Each replaces its read-only twin.
const SUPERSEDES = { 'Mail.ReadWrite': 'Mail.Read', 'Calendars.ReadWrite': 'Calendars.Read' };
const hasScope = (scope, need) => (scope || SCOPE).split(' ').includes(need);
function withScope(scope, need) {
  const parts = (scope || SCOPE).split(' ').filter((p) => p !== SUPERSEDES[need]);
  return parts.includes(need) ? parts.join(' ') : [...parts, need].join(' ');
}
const KEY = 'ms:auth';
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export class NeedsConnect extends Error {
  constructor(message = 'Outlook is not connected') {
    super(message);
    this.code = 'needs-connect';
  }
}

// Work and school tenants usually block people from approving mail access themselves.
export const adminConsentUrl = (clientId) =>
  `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${new URLSearchParams({
    client_id: clientId,
    scope: ['User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Calendars.Read', 'Calendars.ReadWrite'].map((p) => `https://graph.microsoft.com/${p}`).join(' '),
    redirect_uri: chrome.identity.getRedirectURL(),
  })}`;

export class NeedsAdmin extends Error {
  constructor(clientId) {
    super('Your organization needs to approve Daybook before you can connect this account.');
    this.code = 'needs-admin';
    this.adminUrl = adminConsentUrl(clientId);
  }
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

function idClaims(idToken) {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return {};
  }
}

const ADMIN_CODES = /AADSTS(90094|90095|900941|65001)\b/;

async function tokenRequest(clientId, params, authority = COMMON, scope = SCOPE) {
  const res = await fetch(`${authority}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (ADMIN_CODES.test(json.error_description || '')) throw new NeedsAdmin(clientId);
    throw new Error(json.error_description?.split(/\r?\n/)[0] || json.error || `Sign-in failed (${res.status})`);
  }
  const claims = json.id_token ? idClaims(json.id_token) : {};
  return {
    clientId,
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 120) * 1000,
    username: claims.preferred_username,
    tid: claims.tid,
    personal: claims.tid ? claims.tid === CONSUMER_TENANT : undefined,
    scope,
  };
}

// `hint` is the stored sign-in: with it, Microsoft goes straight to that account.
async function authorize(clientId, interactive, hint, scope = hint?.scope || SCOPE) {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  const redirect = chrome.identity.getRedirectURL();
  const params = {
    client_id: clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirect,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (!interactive) params.prompt = 'none';
  else if (!hint) params.prompt = 'select_account';
  if (hint?.username) params.login_hint = hint.username;
  const authority = hint ? authorityFor(hint) : COMMON;
  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow(
      interactive
        ? { url: `${authority}/authorize?${new URLSearchParams(params)}`, interactive }
        : { url: `${authority}/authorize?${new URLSearchParams(params)}`, interactive, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 20000 },
    );
  } catch (err) {
    if (interactive && /did not approve|closed|cancel/i.test(String(err?.message))) throw new Error('Microsoft sign-in was cancelled.');
    throw err;
  }
  const back = new URL(result);
  const error = back.searchParams.get('error');
  if (error) {
    const detail = back.searchParams.get('error_description') || error;
    if (ADMIN_CODES.test(detail) || error === 'consent_required') {
      if (interactive || error !== 'consent_required') throw new NeedsAdmin(clientId);
    }
    if (error === 'access_denied') throw new Error('Microsoft sign-in was cancelled.');
    throw new Error(detail.split(/\r?\n/)[0]);
  }
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted. Try again.');
  return tokenRequest(
    clientId,
    { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier },
    authority,
    scope,
  );
}

export async function connect(clientId) {
  const auth = await authorize(clientId.trim(), true);
  const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,givenName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${auth.access}` },
  }).then((r) => r.json());
  auth.account = me.mail || me.userPrincipalName || auth.username || 'Microsoft account';
  auth.givenName = me.givenName || '';
  auth.username ||= me.userPrincipalName;
  await local.set(KEY, auth);
  return auth;
}

export async function disconnect() {
  await local.remove([KEY, 'cache:outlook-mail', 'cache:cal:outlook']);
}

export async function msAccount() {
  return (await local.get(KEY))?.account || null;
}

let renewing = null;

async function getToken(clientId) {
  if (!clientId) throw new NeedsConnect('Outlook sign-in isn’t set up in this copy of Daybook');
  const auth = await local.get(KEY);
  if (!auth || auth.clientId !== clientId) throw new NeedsConnect();
  if (auth.access && auth.expiresAt > Date.now()) return auth.access;
  renewing ??= (async () => {
    let next = null;
    if (auth.refresh) {
      next = await tokenRequest(clientId, { grant_type: 'refresh_token', refresh_token: auth.refresh }, authorityFor(auth), auth.scope || SCOPE).catch(() => null);
    }
    // Refresh tokens for browser apps last 24 hours. After that, sign in again silently
    // using the Microsoft session already in this Chrome profile.
    next ??= await authorize(clientId, false, auth).catch(() => null);
    if (!next) throw new NeedsConnect('Outlook sign-in expired');
    const saved = { ...auth, ...next, username: next.username || auth.username, tid: next.tid || auth.tid, personal: next.personal ?? auth.personal, scope: auth.scope || SCOPE };
    await local.set(KEY, saved);
    return saved.access;
  })().finally(() => (renewing = null));
  return renewing;
}

export async function graph(clientId, path, headers = {}) {
  const token = await getToken(clientId);
  // Accepts a path, or a full @odata.nextLink URL when paging.
  const url = path.startsWith('https://graph.microsoft.com/') ? path : `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  if (res.status === 401) {
    const auth = await local.get(KEY);
    if (auth) await local.set(KEY, { ...auth, expiresAt: 0 });
    throw new NeedsConnect('Outlook sign-in expired');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `Outlook returned ${res.status}`);
  }
  return res.json();
}

// Changes need a write permission. The first time, Microsoft shows a consent window for that
// one extra permission; after that the stored sign-in carries it.
async function writeToken(clientId, need) {
  const auth = await local.get(KEY);
  if (!auth || auth.clientId !== clientId) throw new NeedsConnect();
  if (hasScope(auth.scope, need)) return getToken(clientId);
  const scope = withScope(auth.scope, need);
  const next = await authorize(clientId, true, auth, scope);
  const saved = { ...auth, ...next, username: next.username || auth.username, tid: next.tid || auth.tid, personal: next.personal ?? auth.personal, scope };
  await local.set(KEY, saved);
  return saved.access;
}

export async function graphWrite(clientId, path, { method = 'POST', body, need = 'Mail.ReadWrite' } = {}) {
  const token = await writeToken(clientId, need);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new NeedsConnect('Outlook sign-in expired');
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403) throw new Error(`Outlook didn’t allow the change. The person who shared Daybook needs to add the ${need} permission to the Microsoft app`);
    throw new Error(j.error?.message || `Outlook returned ${res.status}`);
  }
  return j;
}
