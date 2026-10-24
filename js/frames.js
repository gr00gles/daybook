// Pages Daybook reads out of sight: a carrier's tracking page (tracking.js) or Gmail's own
// page (shipmail.js), loaded in a hidden frame on the new tab page with the browser's own
// sign-ins, the way you'd open them yourself. A content script inside the frame reads what the
// page shows and reports back with chrome.runtime.sendMessage. Those sites don't let other
// pages show theirs in a frame, so a session rule lifts that while Daybook reads them, for its
// own frames in its own tab.
import { $ } from './util.js';

// One rule per site group, so each lifts the refusal only for its own hosts: in this tab, for
// frames Daybook opens and the frames those pages open themselves (Gmail's page has a few), and
// only until dropFrames. Anywhere else, including your own tabs on those sites, nothing changes.
export async function allowFrames(id, hosts) {
  const tab = await chrome.tabs?.getCurrent?.().catch(() => null);
  const where = tab?.id != null ? { tabIds: [tab.id], initiatorDomains: [chrome.runtime.id, ...hosts] } : { initiatorDomains: [chrome.runtime.id] };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'].map((header) => ({ header, operation: 'remove' })),
        },
        condition: { requestDomains: hosts, resourceTypes: ['sub_frame'], ...where },
      },
    ],
  });
}

export const dropFrames = (id) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});

// Kept inside the window, under everything and see-through: Chrome holds back frames scrolled
// out of view, and these pages only fill in when they're drawn.
function box() {
  let el = $('#hidden-frames');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hidden-frames';
    el.setAttribute('aria-hidden', 'true');
    document.body.append(el);
  }
  return el;
}

const onHosts = (url, hosts) => {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
};

// Opens `url` out of sight and resolves with the first message of `type` that a frame on one of
// `hosts` sends (and that `accept` takes, when given), or with null after `wait` ms. The frame
// goes away either way.
export function readHidden(url, { type, hosts, wait, accept = () => true }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    // No navigating this tab, no pop-ups: the page only gets to show itself.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    frame.setAttribute('tabindex', '-1');
    frame.src = url;
    let timer;
    const finish = (msg) => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(heard);
      frame.remove();
      resolve(msg);
    };
    const heard = (msg, sender) => {
      if (msg?.type !== type || sender.id !== chrome.runtime.id || !onHosts(sender.url, hosts) || !accept(msg, sender)) return;
      finish(msg);
    };
    chrome.runtime.onMessage.addListener(heard);
    timer = setTimeout(() => finish(null), wait);
    box().append(frame);
  });
}
