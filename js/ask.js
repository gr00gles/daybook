// Ask Claude, ChatGPT or Gemini from the search box. With an API key saved in Settings, the
// answer streams into a bubble under the search box and follow-ups continue the same
// conversation. Without a key, the AI's own site opens in the bubble, signed in with your account
// in Chrome, and the next question opens that conversation on the site, typed in and waiting.
// Keys stay in chrome.storage.local on this computer; they never sync with your profile.
import { $, esc, safeUrl, local, showPop } from './util.js';
import { icon, aiMark } from './icons.js';
import { allowFrames, dropFrames } from './frames.js';

export const AI_DEFAULTS = { anthropicKey: '', claudeModel: 'claude-opus-5-5', openaiKey: '', openaiModel: 'gpt-5', geminiKey: '', geminiModel: 'gemini-flash-latest' };

export const CLAUDE_MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (smartest)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, cheapest)',
};

const PROVIDERS = {
  claude: { label: 'Claude', site: 'Claude.ai', siteUrl: 'https://claude.ai/new?q=%s', keyField: 'anthropicKey' },
  chatgpt: { label: 'ChatGPT', site: 'ChatGPT', siteUrl: 'https://chatgpt.com/?q=%s', keyField: 'openaiKey' },
  gemini: { label: 'Gemini', site: 'Gemini', siteUrl: 'https://gemini.google.com/app#daybook-q=%s', keyField: 'geminiKey' },
};

const SYSTEM =
  'You answer questions typed into the search box on a browser new tab page. Answer directly and briefly: lead with the answer, ' +
  'then a few sentences or a short list if detail helps. Use Markdown sparingly (bold, lists, inline code, fenced code).';

let ai = { ...AI_DEFAULTS, ...(await local.get('ai')) };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ai) ai = { ...AI_DEFAULTS, ...changes.ai.newValue };
});

export const loadAi = async () => ({ ...AI_DEFAULTS, ...(await local.get('ai')) });
export const saveAi = (value) => local.set('ai', value);

export const hasKey = (engine) => Boolean(ai[PROVIDERS[engine]?.keyField]?.trim());
export const siteUrl = (engine, q) => PROVIDERS[engine].siteUrl.replace('%s', encodeURIComponent(q));

// ---- Streaming ----------------------------------------------------------------------

// Reads a server-sent event stream and hands each data payload to onData.
async function readSSE(res, onData) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Gemini ends its lines with \r\n; a \r at the end of a piece waits for the \n after it.
    buf = (buf + value).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') onData(JSON.parse(data));
    }
  }
}

async function failure(res, who) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {}
  if (res.status === 401) return new Error(`${who} didn’t accept the API key. Check it in Settings.`);
  if (res.status === 429) return new Error(detail || `${who} says you’re sending too many requests or are out of credit.`);
  return new Error(detail || `${who} answered with HTTP ${res.status}.`);
}

async function streamClaude(messages, onText, signal) {
  const model = ai.claudeModel || AI_DEFAULTS.claudeModel;
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    system: SYSTEM,
    // Quick answers: low effort keeps the thinking short before the reply starts.
    output_config: { effort: 'low' },
    messages,
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': ai.anthropicKey.trim(),
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // If a safety check declines the question, Anthropic retries it on a model it picks.
  // Haiku has no fallback model.
  if (!model.includes('haiku')) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await failure(res, 'Anthropic');
  let stop = null;
  await readSSE(res, (ev) => {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onText(ev.delta.text);
    else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason ?? stop;
    else if (ev.type === 'error') throw new Error(ev.error?.message || 'Claude stopped with an error.');
  });
  if (stop === 'refusal') throw new Error('Claude declined to answer this one.');
  if (stop === 'max_tokens') onText('\n\n…');
}

async function streamOpenAI(messages, onText, signal) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ai.openaiKey.trim()}` },
    body: JSON.stringify({
      model: ai.openaiModel.trim() || AI_DEFAULTS.openaiModel,
      stream: true,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
    signal,
  });
  if (!res.ok) throw await failure(res, 'OpenAI');
  await readSSE(res, (ev) => {
    if (ev.error) throw new Error(ev.error.message || 'ChatGPT stopped with an error.');
    const text = ev.choices?.[0]?.delta?.content;
    if (text) onText(text);
  });
}

async function streamGemini(messages, onText, signal) {
  const model = ai.geminiModel.trim() || AI_DEFAULTS.geminiModel;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.geminiKey.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    }),
    signal,
  });
  if (!res.ok) throw await failure(res, 'Google');
  await readSSE(res, (ev) => {
    if (ev.error) throw new Error(ev.error.message || 'Gemini stopped with an error.');
    const text = (ev.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (text) onText(text);
  });
}

// ---- Markdown, kept small: escaped first, then a few constructs --------------------

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url.replace(/&amp;/g, '&'));
      return href === '#' ? text : `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
    });
}

export function renderMarkdown(src) {
  const out = [];
  const parts = String(src).split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2) {
      out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let list = null;
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    for (const raw of part.split('\n')) {
      const line = esc(raw);
      const h = line.match(/^#{1,6}\s+(.*)$/);
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (!line.trim()) {
        flush();
        closeList();
      } else if (h) {
        flush();
        closeList();
        out.push(`<h4>${inline(h[1])}</h4>`);
      } else if (ul || ol) {
        flush();
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else {
        closeList();
        para.push(line);
      }
    }
    flush();
    closeList();
  });
  return out.join('');
}

// ---- The bubble ---------------------------------------------------------------------

let bubble;
let convo = { engine: null, messages: [] };
let controller = null;

function close() {
  controller?.abort();
  controller = null;
  if (convo.site) dropFrames(FRAME_RULE);
  convo = { engine: null, messages: [] };
  showPop(bubble, false);
  bubble.classList.remove('site');
}

function paint() {
  const p = PROVIDERS[convo.engine];
  bubble.classList.toggle('site', Boolean(convo.site));
  if (convo.site) return paintSite(p);
  const last = convo.messages.findLast((m) => m.role === 'user')?.content || '';
  bubble.innerHTML = `<header class="ask-head">
      <span class="ask-who">${esc(p.label)}</span>
      <span class="ask-hint">${controller ? 'Answering…' : 'Type a follow-up in the search box'}</span>
      <button type="button" class="icon-btn small" data-ask="copy" title="Copy answer" aria-label="Copy answer">${icon('copy')}</button>
      <a class="icon-btn small" href="${esc(siteUrl(convo.engine, last))}" title="Ask in ${esc(p.site)} instead" aria-label="Ask in ${esc(p.site)} instead">${icon('external')}</a>
      <button type="button" class="icon-btn small" data-ask="close" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="ask-log" aria-live="polite">${convo.messages
      .map((m) =>
        m.role === 'user'
          ? `<p class="ask-q">${esc(m.content)}</p>`
          : `<div class="ask-a">${m.content ? renderMarkdown(m.content) : m.error ? '' : '<p class="ask-wait"><span></span><span></span><span></span></p>'}${m.error ? `<p class="ask-error">${esc(m.error)}</p>` : ''}</div>`,
      )
      .join('')}</div>`;
  const log = bubble.querySelector('.ask-log');
  log.scrollTop = log.scrollHeight;
}

export async function ask(engine, question) {
  if (convo.engine !== engine || convo.site) {
    controller?.abort();
    if (convo.site) dropFrames(FRAME_RULE);
    convo = { engine, messages: [] };
  }
  controller?.abort();
  // A question asked while the last answer was still coming replaces that unfinished turn.
  if (convo.messages.at(-1)?.role === 'assistant' && convo.messages.at(-1).pending) convo.messages.splice(-2, 2);
  const mine = new AbortController();
  controller = mine;
  convo.messages.push({ role: 'user', content: question });
  const reply = { role: 'assistant', content: '', pending: true };
  convo.messages.push(reply);
  showPop(bubble, true);
  paint();
  // Earlier turns that ended in an error are left out of what is sent.
  const history = [];
  for (let i = 0; i < convo.messages.length - 2; i += 2) {
    const [q, a] = convo.messages.slice(i, i + 2);
    if (!a.error) history.push({ role: 'user', content: q.content }, { role: 'assistant', content: a.content });
  }
  history.push({ role: 'user', content: question });
  let frame = 0;
  const onText = (t) => {
    reply.content += t;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (controller === mine) paint();
    });
  };
  try {
    await { claude: streamClaude, chatgpt: streamOpenAI, gemini: streamGemini }[engine](history, onText, mine.signal);
    if (!reply.content.trim()) reply.error = 'No answer came back. Try asking again.';
  } catch (err) {
    if (mine.signal.aborted) return;
    reply.error = err instanceof TypeError ? `Couldn’t reach ${PROVIDERS[engine].label}. Check your internet connection.` : err.message;
  }
  delete reply.pending;
  if (controller !== mine) return;
  controller = null;
  cancelAnimationFrame(frame);
  paint();
}

// ---- The site in the bubble ----------------------------------------------------------
// Without an API key, the AI's own site opens in the bubble, signed in with your account in
// Chrome, so it answers on your plan with no key. The sites don't let other pages show them, so
// a session rule lets them, in this tab's frames only, while the bubble is open (frames.js).
// js/ai-page.js, inside the frame, says which conversation is showing; the next question you
// type opens that conversation on the site, with the question typed in and ready to send.

const FRAME_RULE = 4103;
const HOSTS = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com' };
export const SIGN_IN = { claude: 'https://claude.ai/login', chatgpt: 'https://chatgpt.com/auth/login', gemini: 'https://gemini.google.com/app' };
// What opens in the frame. ChatGPT sends a question in its link itself; for Claude and Gemini,
// js/ai-page.js types it in and sends it.
const frameUrl = (engine, q) =>
  engine === 'chatgpt' ? siteUrl(engine, q) : `https://${HOSTS[engine]}/${engine === 'claude' ? 'new' : 'app'}#daybook-q=${encodeURIComponent(q)}`;

// Buttons to sign in to each site, for Settings and first-run setup.
export const aiSignIns = () =>
  `<div class="row-actions ai-signins">${Object.keys(HOSTS)
    .map((k) => `<a class="btn small" href="${esc(SIGN_IN[k])}" target="_blank" rel="noopener">${aiMark(k)}Sign in to ${esc(PROVIDERS[k].label)}</a>`)
    .join('')}</div>`;

let myTab = null;
chrome.tabs?.getCurrent?.().then((t) => (myTab = t?.id ?? null)).catch(() => {});

function paintSite(p) {
  const { engine, question } = convo;
  bubble.innerHTML = `<header class="ask-head">
      <span class="ask-who">${esc(p.label)}</span>
      <span class="ask-hint">Your next question opens this chat on ${esc(p.site)}</span>
      <a class="icon-btn small" data-ask="open" href="${esc(convo.url || `https://${HOSTS[engine]}/`)}" title="Open this chat on ${esc(p.site)}" aria-label="Open this chat on ${esc(p.site)}">${icon('external')}</a>
      <button type="button" class="icon-btn small" data-ask="close" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
    </header>
    <div class="ask-site">
      <iframe src="${esc(frameUrl(engine, question))}" title="${esc(p.label)}" allow="clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"></iframe>
      <div class="ask-slow" hidden>
        <p>${esc(p.label)} didn’t open here. If you aren’t signed in to ${esc(p.site)} in Chrome, sign in once and ask again.</p>
        <div class="row-actions"><a class="btn small primary" href="${esc(SIGN_IN[engine])}" target="_blank" rel="noopener">Sign in to ${esc(p.site)}</a><a class="btn small" href="${esc(siteUrl(engine, question))}">Ask on ${esc(p.site)}</a></div>
      </div>
    </div>`;
}

// Asks on the AI's site: in the bubble the first time, and after that on the site itself, in the
// same conversation. Returns the address to go to for that, or null when the bubble took it.
export async function askOnSite(engine, question) {
  if (convo.site && convo.engine === engine && !bubble.hidden) {
    return convo.url ? `${convo.url}#daybook-draft=${encodeURIComponent(question)}` : siteUrl(engine, question);
  }
  controller?.abort();
  controller = null;
  convo = { engine, messages: [], site: true, url: null, question };
  await allowFrames(FRAME_RULE, Object.values(HOSTS));
  paint();
  showPop(bubble, true);
  const mine = convo;
  // Nothing heard from the page: it didn't load here, or asked to sign in somewhere it can't.
  setTimeout(() => {
    if (convo === mine && !mine.url) bubble.querySelector('.ask-slow')?.removeAttribute('hidden');
  }, 15000);
  return null;
}

function heardFromSite(msg, sender) {
  if (msg?.type !== 'ai-page' || !convo.site || sender.id !== chrome.runtime.id || (myTab !== null && sender.tab?.id !== myTab)) return;
  let u;
  try {
    u = new URL(msg.url);
  } catch {
    return;
  }
  if (u.hostname !== HOSTS[convo.engine]) return;
  // Without the question in the link, so opening it doesn't ask again.
  u.searchParams.delete('q');
  u.hash = '';
  convo.url = u.href;
  bubble.querySelector('.ask-slow')?.setAttribute('hidden', '');
  const open = bubble.querySelector('[data-ask="open"]');
  if (open) open.href = convo.url;
}

export function initAsk(input) {
  bubble = $('#ask');
  chrome.runtime.onMessage.addListener(heardFromSite);
  bubble.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ask]');
    if (!b) return;
    if (b.dataset.ask === 'close') {
      close();
      input.focus();
    } else if (b.dataset.ask === 'copy') {
      const text = convo.messages.findLast((m) => m.role === 'assistant' && m.content)?.content;
      if (text) await navigator.clipboard.writeText(text);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bubble.hidden && !document.querySelector('dialog[open]')) close();
  });
}
