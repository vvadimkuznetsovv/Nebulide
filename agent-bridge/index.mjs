// Nebulide agent-bridge: bridges the Go backend ↔ Claude Agent SDK.
//
// Protocol (newline-delimited JSON):
//   stdin  (Go → bridge):
//     {type:'init', cwd, resume?, permissionMode?}      — first message, starts the session
//     {type:'user', text}                                — a user turn
//     {type:'permission', requestId, behavior, allowAlways?, scope?}
//     {type:'set_mode', mode}                            — default|plan|acceptEdits|bypassPermissions
//     {type:'abort'}
//   stdout (bridge → Go):
//     {type:'init', session_id}
//     {type:'delta', text}                               — streamed assistant text
//     {type:'message', message:{uuid,role,blocks,timestamp}}
//     {type:'permission_request', requestId, tool, input}
//     {type:'result', subtype}
//     {type:'error', message}
//     {type:'mode', mode}

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── Content blocks → RichMessage blocks (same shape as the Go TailSession) ──
function toBlocks(content) {
  if (typeof content === 'string') {
    const t = content.trim();
    return t ? [{ kind: 'text', text: t }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) blocks.push({ kind: 'text', text: b.text });
    else if (b.type === 'thinking' && b.thinking) blocks.push({ kind: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use') blocks.push({ kind: 'tool_use', name: b.name, input: b.input, tool_use_id: b.id });
    else if (b.type === 'tool_result') {
      let text = '';
      if (typeof b.content === 'string') text = b.content;
      else if (Array.isArray(b.content)) text = b.content.filter(x => x?.type === 'text').map(x => x.text).join('\n');
      blocks.push({ kind: 'tool_result', tool_use_id: b.tool_use_id, content: text, is_error: !!b.is_error });
    }
  }
  return blocks;
}

// ── Async queue feeding the SDK streaming prompt ──
const END = Symbol('end');
let pushResolve = null;
const pending = [];
function pushUser(text) {
  const item = { type: 'user', message: { role: 'user', content: text } };
  if (pushResolve) { pushResolve(item); pushResolve = null; }
  else pending.push(item);
}
function endInput() {
  if (pushResolve) { pushResolve(END); pushResolve = null; }
  else pending.push(END);
}
async function* promptGen() {
  while (true) {
    let item;
    if (pending.length) item = pending.shift();
    else item = await new Promise((r) => { pushResolve = r; });
    if (item === END) return;
    yield item;
  }
}

// ── Permission requests awaiting a human decision ──
const permWaiters = new Map(); // requestId → resolve

function scopeToDestination(scope) {
  if (scope === 'project') return 'projectSettings';
  if (scope === 'always') return 'userSettings';
  return 'session';
}

async function canUseTool(toolName, input, { signal }) {
  const requestId = randomUUID();
  out({ type: 'permission_request', requestId, tool: toolName, input });
  return new Promise((resolve) => {
    const onAbort = () => { permWaiters.delete(requestId); resolve({ behavior: 'deny', message: 'Aborted' }); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    permWaiters.set(requestId, (decision) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (decision.behavior === 'deny') {
        resolve({ behavior: 'deny', message: decision.message || 'Отклонено пользователем' });
        return;
      }
      const res = { behavior: 'allow', updatedInput: input };
      if (decision.allowAlways) {
        res.updatedPermissions = [{
          type: 'addRules',
          rules: [{ toolName }],
          behavior: 'allow',
          destination: scopeToDestination(decision.scope),
        }];
      }
      resolve(res);
    });
  });
}

let q = null;

async function runQuery(initMsg) {
  const options = {
    cwd: initMsg.cwd || process.cwd(),
    includePartialMessages: true,
    canUseTool,
    permissionMode: initMsg.permissionMode || 'default',
  };
  if (initMsg.resume) options.resume = initMsg.resume;

  q = query({ prompt: promptGen(), options });

  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        out({ type: 'init', session_id: msg.session_id });
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          out({ type: 'delta', text: ev.delta.text });
        }
      } else if (msg.type === 'assistant' || msg.type === 'user') {
        const blocks = toBlocks(msg.message?.content);
        if (blocks.length) {
          out({ type: 'message', message: { uuid: msg.uuid || randomUUID(), role: msg.type, blocks, timestamp: new Date().toISOString() } });
        }
      } else if (msg.type === 'result') {
        out({ type: 'result', subtype: msg.subtype });
      }
    }
  } catch (e) {
    out({ type: 'error', message: String(e?.message || e) });
  }
}

// ── stdin command loop ──
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  switch (cmd.type) {
    case 'init':
      if (!q) runQuery(cmd);
      break;
    case 'user':
      if (cmd.text) pushUser(cmd.text);
      break;
    case 'permission': {
      const w = permWaiters.get(cmd.requestId);
      if (w) { permWaiters.delete(cmd.requestId); w(cmd); }
      break;
    }
    case 'set_mode':
      if (q && cmd.mode) { try { q.setPermissionMode(cmd.mode); out({ type: 'mode', mode: cmd.mode }); } catch (e) { out({ type: 'error', message: String(e?.message || e) }); } }
      break;
    case 'abort':
      try { q?.interrupt?.(); } catch { /* ignore */ }
      break;
  }
});

rl.on('close', () => { endInput(); try { q?.interrupt?.(); } catch { /* ignore */ } process.exit(0); });
process.on('SIGTERM', () => { try { q?.interrupt?.(); } catch { /* ignore */ } process.exit(0); });
