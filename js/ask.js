// Ask Claude or ChatGPT from the search box. With an API key saved in Settings, the answer
// streams into a bubble under the search box and follow-ups continue the same conversation.
// Without a key, the question opens in claude.ai or chatgpt.com, where you are signed in.
// Keys stay in chrome.storage.local on this computer; they never sync with your profile.
import { $, esc, safeUrl, local } from './util.js';
import { icon } from './icons.js';

export const AI_DEFAULTS = { anthropicKey: '', claudeModel: 'claude-opus-5-5', openaiKey: '', openaiModel: 'gpt-5' };

export const CLAUDE_MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (smartest)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, cheapest)',
};

const PROVIDERS = {
  claude: { label: 'Claude', site: 'Claude.ai', siteUrl: 'https://claude.ai/new?q=%s', keyField: 'anthropicKey' },
  chatgpt: { label: 'ChatGPT', site: 'ChatGPT', siteUrl: 'https://chatgpt.com/?q=%s', keyField: 'openaiKey' },
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
    buf += value;
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
  convo = { engine: null, messages: [] };
  if (bubble) bubble.hidden = true;
}

function paint() {
  const p = PROVIDERS[convo.engine];
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
  if (convo.engine !== engine) {
    controller?.abort();
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
  bubble.hidden = false;
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
    await (engine === 'claude' ? streamClaude : streamOpenAI)(history, onText, mine.signal);
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

export function initAsk(input) {
  bubble = $('#ask');
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
