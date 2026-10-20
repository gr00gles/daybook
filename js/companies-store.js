// The companies you deal with, one page each. Kept in Chrome sync so they follow your profile,
// each company in its own item (company:<id>), since Chrome lets one sync item hold only 8 KB.
// Also matches mail and deliveries to a company by the sender's domain or name.

const PREFIX = 'company:';

export async function listCompanies() {
  const all = await chrome.storage.sync.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(PREFIX) && v && typeof v === 'object')
    .map(([, v]) => ({ ...blank(), ...v }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}

export const saveCompany = (c) => chrome.storage.sync.set({ [PREFIX + c.id]: c });
export const removeCompany = (id) => chrome.storage.sync.remove(PREFIX + id);
export const isCompanyKey = (key) => key.startsWith(PREFIX);

function blank() {
  return {
    id: '',
    name: '',
    category: '',
    website: '',
    phone: '',
    email: '',
    account: '',
    address: '',
    hours: '',
    people: '',
    notes: '',
    domains: '', // more email domains the company writes from, separated by commas
    links: [], // [{ label, url }]
    about: null, // { title, description, extract, url, at } from Wikipedia
  };
}

export function newCompany(name = '', website = '') {
  return { ...blank(), id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, website, added: Date.now() };
}

// "mail.shipment.amazon.com" → "amazon.com", "news.bbc.co.uk" → "bbc.co.uk".
export function baseDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts.at(-1).length === 2 && /^(?:co|com|net|org|gov|edu|ac|ne|or)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
}

// The domain of a web address, an email address or a bare domain, or ''.
export function domainOf(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return baseDomain(s.split('@')[1]);
  try {
    return baseDomain(new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname);
  } catch {
    return '';
  }
}

export function companyDomains(c) {
  const out = new Set([domainOf(c.website), domainOf(c.email), ...String(c.domains || '').split(/[\s,;]+/).map(domainOf)]);
  out.delete('');
  return out;
}

// A web address as typed ("lowes.com") as one a link can use, or ''.
export function webUrl(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(url).hostname.includes('.') ? url : '';
  } catch {
    return '';
  }
}

// Site logos from Google's favicon service, which knows sites you've never visited.
export const logoUrl = (domain, size = 64) => (domain ? `https://www.google.com/s2/favicons?${new URLSearchParams({ domain, sz: String(size) })}` : '');

// Whether a mail item ({ from, fromAddr }) came from this company.
export function fromCompany(c, m, domains = companyDomains(c)) {
  const d = domainOf(m.fromAddr);
  if (d && domains.has(d)) return true;
  const name = (c.name || '').trim().toLowerCase();
  return name.length >= 4 && (m.from || '').toLowerCase().includes(name);
}

// Mail providers people write from: never a company of their own.
export const PERSONAL_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'comcast.net',
  'verizon.net', 'att.net', 'sbcglobal.net', 'charter.net', 'cox.net', 'zoho.com', 'fastmail.com', 'hey.com',
]);
