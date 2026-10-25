// First-run setup: connect Google, connect Outlook, sign in to the AIs, then a few personal touches.
// Shown on the first new tab after installing, and again from Settings → Run setup again.
import { $, esc } from './util.js';
import { saveSettings, NEWS_TOPICS } from './settings.js';
import { googleConfigured } from './gauth.js';
import { mountGoogle, mountGmail, mountOutlook, mountLocation } from './setup-ui.js';
import { aiSignIns } from './ask.js';

const STEPS = ['welcome', 'google', 'outlook', 'ai', 'yours'];
const LABELS = { google: 'Google', outlook: 'Outlook', ai: 'AI', yours: 'Your page' };

let draft;
let step = 0;
let saveTimer;

const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(draft), 250);
};

function progress() {
  const shown = STEPS.slice(1);
  return `<ol class="wiz-steps" aria-label="Setup steps">${shown
    .map((s, i) => {
      const n = i + 1;
      const state = n < step ? 'done' : n === step ? 'current' : '';
      return `<li class="${state}"${n === step ? ' aria-current="step"' : ''}><span class="wiz-n">${n}</span>${LABELS[s]}</li>`;
    })
    .join('')}</ol>`;
}

function body() {
  switch (STEPS[step]) {
    case 'welcome':
      return `
        <h1 class="wiz-title">Welcome to Daybook</h1>
        <p class="wiz-lede">Every new tab will show your calendar, your unread mail, the weather and the headlines. Connect your accounts once and you’re set. It takes about two minutes.</p>
        <ul class="wiz-list">
          <li><strong>Google</strong> for your calendar and Gmail</li>
          <li><strong>Outlook</strong> for Outlook.com or work mail and calendar</li>
          <li><strong>Weather and headlines</strong> for where you live</li>
        </ul>
        <p class="hint">Everything stays in your browser. Daybook never sends email, and it only changes your mail when you click Mark as read or Delete.</p>`;
    case 'google':
      return `
        <h1 class="wiz-title">Connect Google</h1>
        <p class="wiz-lede">Shows your Google Calendar events and your unread Gmail.</p>
        ${googleConfigured()
          ? `<div class="wiz-heads-up">
              <p><strong>What you’ll see:</strong></p>
              <ol>
                <li>Chrome may ask you to sign in to Chrome with your Google account. Say yes.</li>
                <li>Google will say <em>“Google hasn’t verified this app.”</em> That’s normal for small private apps like this one. Click <strong>Advanced</strong>, then <strong>Go to Daybook</strong>.</li>
                <li>Tick the calendar box and click <strong>Continue</strong>.</li>
              </ol>
            </div>
            <h2 class="wiz-sub">Calendar</h2>
            <div id="wiz-google"></div>`
          : ''}
        <h2 class="wiz-sub">Gmail</h2>
        <div id="wiz-gmail"></div>`;
    case 'outlook':
      return `
        <h1 class="wiz-title">Connect Outlook</h1>
        <p class="wiz-lede">Shows unread Outlook mail and your Outlook calendar. Skip this if you don’t use Outlook.</p>
        <div class="wiz-heads-up">
          <p>Works with Outlook.com, Hotmail and Live accounts. Microsoft will list Daybook as <em>unverified</em>; click <strong>Accept</strong> to continue. If Microsoft asks <em>“Stay signed in?”</em>, choose <strong>Yes</strong> so Daybook stays connected.</p>
          <p>Work or school accounts often need an IT admin to approve Daybook first. If so, you’ll get a link to send them.</p>
        </div>
        <div id="wiz-outlook" class="wiz-gap"></div>`;
    case 'ai':
      return `
        <h1 class="wiz-title">Sign in to Claude, ChatGPT and Gemini</h1>
        <p class="wiz-lede">Click the circle at the start of the search box to ask one of them. The answer drops down right there, from the AI’s own site, using your own account and plan. Skip the ones you don’t use.</p>
        <div class="wiz-heads-up"><p>Each button opens the site in a new tab. Sign in there, then come back to this tab. If you’re already signed in, there’s nothing to do.</p></div>
        ${aiSignIns()}`;
    case 'yours':
      return `
        <h1 class="wiz-title">Make it yours</h1>
        <div class="grid2">
          <label class="field"><span>Your first name, for the greeting</span><input id="wiz-name" type="text" value="${esc(draft.name)}" autocomplete="given-name"></label>
          <div class="field"><span>Temperature</span>
            <div class="seg" role="radiogroup" aria-label="Temperature units">
              <label><input type="radio" name="wiz-units" value="F"${draft.units === 'F' ? ' checked' : ''}><span>°F</span></label>
              <label><input type="radio" name="wiz-units" value="C"${draft.units === 'C' ? ' checked' : ''}><span>°C</span></label>
            </div>
          </div>
        </div>
        <h2 class="wiz-sub">Weather location</h2>
        <div id="wiz-location"></div>
        <h2 class="wiz-sub">Headlines</h2>
        <div class="topics">${Object.entries(NEWS_TOPICS)
          .map(([k, t]) => `<label class="check"><input type="checkbox" data-topic="${k}"${draft.news.topics.includes(k) ? ' checked' : ''}><span>${t.label}</span></label>`)
          .join('')}</div>`;
  }
}

function footer() {
  const id = STEPS[step];
  const back = step > 0 ? '<button class="btn ghost" type="button" data-wiz="back">Back</button>' : '<span></span>';
  if (id === 'welcome') return `${back}<div class="wiz-actions"><button class="linklike" type="button" data-wiz="skip-all">Skip setup</button><button class="btn primary big" type="button" data-wiz="next" autofocus>Get started</button></div>`;
  if (id === 'yours') return `${back}<div class="wiz-actions"><button class="btn primary big" type="button" data-wiz="finish">Open Daybook</button></div>`;
  return `${back}<div class="wiz-actions"><button class="linklike" type="button" data-wiz="next">Skip for now</button><button class="btn primary big" type="button" data-wiz="next">Next</button></div>`;
}

function render() {
  const dlg = $('#welcome');
  dlg.innerHTML = `<div class="wiz">
    <header class="wiz-head"><span class="wiz-brand">Daybook</span>${step > 0 ? progress() : ''}</header>
    <div class="wiz-body">${body()}</div>
    <footer class="wiz-foot">${footer()}</footer>
  </div>`;
  const id = STEPS[step];
  if (id === 'google') {
    if (googleConfigured()) mountGoogle($('#wiz-google'), draft, save);
    mountGmail($('#wiz-gmail'), draft, save);
  } else if (id === 'outlook') {
    mountOutlook($('#wiz-outlook'), draft, save);
  } else if (id === 'yours') {
    mountLocation($('#wiz-location'), draft, save);
  }
  dlg.querySelector('.wiz-title')?.focus?.();
  dlg.scrollTop = 0;
}

async function finish() {
  clearTimeout(saveTimer);
  draft.onboarded = true;
  await saveSettings(draft);
  location.reload();
}

export function openWelcome(S) {
  const dlg = $('#welcome');
  draft = structuredClone(S);
  step = 0;
  // Setup can't be dismissed with Esc by accident; "Skip setup" is the way out.
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wiz]');
    if (!b) return;
    const a = b.dataset.wiz;
    if (a === 'next') step = Math.min(STEPS.length - 1, step + 1);
    else if (a === 'back') step = Math.max(0, step - 1);
    else if (a === 'skip-all' || a === 'finish') return finish();
    save();
    render();
  });
  dlg.addEventListener('input', (e) => {
    if (e.target.id === 'wiz-name') {
      draft.name = e.target.value.trim();
      save();
    }
  });
  dlg.addEventListener('change', (e) => {
    if (e.target.name === 'wiz-units') draft.units = e.target.value;
    else if (e.target.dataset.topic) {
      const set = new Set(draft.news.topics);
      if (e.target.checked) set.add(e.target.dataset.topic);
      else set.delete(e.target.dataset.topic);
      draft.news.topics = Object.keys(NEWS_TOPICS).filter((k) => set.has(k));
    } else return;
    save();
  });
  render();
  dlg.showModal();
}
