// Spawns an agent CLI (Claude Code, Codex, or anything else) for one turn,
// parses its output into readable events, records a run log, detects usage limits,
// and keeps the agent's runtime state (running/idle, current task, last message) current.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT, P, loadConfig, loadRole, setAgent, getAgents, setLimit, runtimeOf, now } from './store.mjs';

export const bus = new EventEmitter(); // emits 'agent-event' { agent, runId, kind, text }
const live = new Map(); // key -> child process (for stop)

const CONTRACT = `
## Harness contract (always applies)
- Board state lives in .harness/ and is changed ONLY through the harness CLI:
  node harness/cli.mjs <command>   (run "node harness/cli.mjs help" for the list)
- Never edit .harness/*.json by hand.
- Report progress with: node harness/cli.mjs task note <ID> "<text>"
- When you believe the task is finished: node harness/cli.mjs task submit <ID> --summary "<what changed, how verified>"
- If you are blocked or need a human decision: node harness/cli.mjs task block <ID> --reason "<question>"
  (this sets the task to pending and opens an issue). Then stop.
- Found a bug or risk outside your task? node harness/cli.mjs issue add "<title>" --type bug --task <ID>
- Do not mark tasks done yourself. The loop marks done after the quality gate and review pass.
- Need a quick answer or small change from another agent (any runtime)? See "node harness/cli.mjs agents",
  then: node harness/cli.mjs ask <agent> "<self-contained request>" [--readonly] [--background]
`;

// Messages CLIs print when an account/plan limit is hit. Only checked when a run FAILS,
// so an agent merely talking about "rate limits" in code never triggers it.
const LIMIT_RE = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|limit (reached|exceeded)|hit your (usage )?limit|insufficient_quota|credit balance/i;

export function detectLimit(text) {
  if (!text || !LIMIT_RE.test(text)) return null;
  const line = text.split('\n').find((l) => LIMIT_RE.test(l)) || text;
  let resets_at = null;
  const epoch = text.match(/limit reached\|(\d{10})/i); // Claude Code: "Claude AI usage limit reached|1759830000"
  if (epoch) resets_at = new Date(Number(epoch[1]) * 1000).toISOString();
  return { message: line.replace(/\|\d{10}/, '').trim().slice(0, 300), resets_at };
}

export function buildSystemPrompt(agentId, role) {
  const def = loadRole(role);
  return `You are agent "${agentId}" with role "${role}" in a multi-agent software project.\n` +
    `Read AGENTS.md first, then follow your role rules below.\n\n${def.body.trim()}\n${CONTRACT}`;
}

function fill(arr, vars) {
  return arr.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
}

// Turn one stdout line into zero or more display events.
function parseLine(parser, line, state) {
  const out = [];
  if (!line.trim()) return out;
  if (parser === 'text') return [{ kind: 'text', text: line }];
  let ev;
  try { ev = JSON.parse(line); } catch { return [{ kind: 'text', text: line }]; }
  const sid = ev.session_id || ev.thread_id || ev.sessionId;
  if (sid) state.sessionId = sid;
  if (parser === 'claude-stream-json') {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text });
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarize(c.input)}` });
      }
    } else if (ev.type === 'result') {
      state.result = ev.result || '';
      state.isError = !!ev.is_error;
      out.push({ kind: ev.is_error ? 'error' : 'result', text: ev.result || ev.subtype || 'finished' });
    }
    return out;
  }
  // Generic JSONL (e.g. codex exec --json): show anything text-like.
  if (ev.type === 'error' || ev.type === 'turn.failed') {
    const msg = ev.message || ev.error?.message || JSON.stringify(ev);
    state.isError = true;
    return [{ kind: 'error', text: msg }];
  }
  const text = ev.text || ev.message?.text || ev.item?.text || ev.msg?.message || ev.content;
  if (typeof text === 'string' && text.trim()) {
    out.push({ kind: 'text', text });
    state.result = text;
  } else if (ev.item?.command || ev.command) {
    out.push({ kind: 'tool', text: `exec ${ev.item?.command || ev.command}` });
  }
  return out;
}

function summarize(input) {
  if (!input) return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.description || JSON.stringify(input);
  return String(v).slice(0, 160);
}

/**
 * Run one agent turn.
 * @param {object} o
 * @param {string} o.agentId   instance id from harness.config.json
 * @param {string} o.prompt    the user/task prompt for this turn
 * @param {string} [o.taskId]  task being worked on (for dashboard)
 * @param {string} [o.session] runtime session id to resume (chat continuity)
 * @param {string} [o.runtime] override the agent's runtime (chat can pick one)
 * @param {string} [o.mode]    'task' | 'chat'
 * @param {string} [o.chatId]  chat session id (chat mode)
 * @param {string} [o.cwd]     working directory (e.g. a git worktree)
 * @param {string} [o.caller]  agent that asked for this run ('ask' mode)
 * @param {number} [o.depth]   nesting depth of agent-to-agent calls
 * @param {string} [o.tools]   override the allowed tool list (e.g. read-only asks)
 * @returns {Promise<{ok, code, sessionId?, result, runId, limited, limit?}>}
 */
export function runAgent(o) {
  const cfg = loadConfig();
  const inst = cfg.agents.find((a) => a.id === o.agentId);
  if (!inst) throw new Error(`Unknown agent ${o.agentId}`);
  const runtimeName = o.runtime || runtimeOf(cfg, inst);
  const rt = cfg.runtimes[runtimeName];
  if (!rt) throw new Error(`Unknown runtime "${runtimeName}"`);
  const def = loadRole(inst.role);
  const system = buildSystemPrompt(inst.id, inst.role);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${inst.id}`;
  const runFile = path.join(P.runs, `${runId}.jsonl`);
  const promptFile = path.join(P.runs, `${runId}.prompt.md`);
  const fullPrompt = `${system}\n\n---\n\n${o.prompt}`;
  fs.writeFileSync(promptFile, fullPrompt);

  const vars = {
    prompt: o.prompt,
    system,
    full_prompt: fullPrompt,
    prompt_file: promptFile,
    tools: o.tools || def.meta.tools || rt.default_tools || '',
    // A model set on the agent only applies to the runtime it was chosen for.
    model: (!o.runtime || o.runtime === runtimeOf(cfg, inst) ? inst.model : '') || rt.default_model || '',
    session: o.session || '',
    agent: inst.id,
    root: ROOT,
  };
  let args = fill(rt.args, vars);
  if (o.session && rt.resume_args) args = [...args, ...fill(rt.resume_args, vars)];
  if (vars.model && rt.model_args) args = [...args, ...fill(rt.model_args, vars)];
  // Drop "--flag ''" pairs whose value resolved to empty (e.g. no tools/model set).
  const cleaned = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1] === '') { i++; continue; }
    cleaned.push(args[i]);
  }
  args = cleaned;

  const isChat = o.mode === 'chat';
  const key = inst.id + (isChat ? ':chat' : '');
  const emit = (kind, text) => {
    const ev = { at: now(), agent: inst.id, runId, mode: o.mode || 'task', chatId: o.chatId, kind, text };
    fs.appendFileSync(runFile, JSON.stringify(ev) + '\n');
    bus.emit('agent-event', ev);
  };
  emit('start', `${rt.cmd} (${runtimeName}) ${o.taskId ? `task ${o.taskId}` : o.mode || ''}`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(rt.cmd, args, {
        cwd: o.cwd || ROOT,
        env: { ...process.env, HARNESS_AGENT: inst.id, HARNESS_TASK: o.taskId || '', HARNESS_ROOT: ROOT, HARNESS_RUNTIME: runtimeName, HARNESS_DEPTH: String(o.depth || 0) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32', // own process group, so Stop kills the whole tree
      });
    } catch (e) {
      emit('error', `spawn failed: ${e.message}`);
      return resolve({ ok: false, code: -1, result: e.message, runId, limited: false });
    }
    live.set(key, child);
    if (!isChat) setAgent(inst.id, { status: 'running', current_task: o.taskId || null, run_id: runId, runtime: runtimeName, agent_pid: child.pid, owner_pid: process.pid, asked_by: o.caller || null, last_message: o.caller ? `asked by ${o.caller}` : `started ${o.taskId || ''}` });
    else setAgent(inst.id, { chat_status: 'replying', chat_pid: child.pid, chat_owner_pid: process.pid });

    const state = { sessionId: null, result: '', isError: false };
    let buf = '';
    let lastText = '';
    let errText = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        for (const e of parseLine(rt.parser, line, state)) {
          emit(e.kind, e.text);
          if (e.kind === 'text' || e.kind === 'result') lastText = e.text;
          if (e.kind === 'error') errText += `${e.text}\n`;
          if (!isChat && (e.kind === 'text' || e.kind === 'tool')) {
            try { setAgent(inst.id, { last_message: e.text.slice(0, 200) }); } catch {}
          }
        }
      }
    });
    child.stderr.on('data', (d) => { const t = d.toString(); errText = (errText + t).slice(-4000); emit('stderr', t.slice(0, 2000)); });
    child.on('error', (err) => { errText += err.message; emit('error', err.code === 'ENOENT' ? `"${rt.cmd}" is not installed or not on PATH` : `spawn failed: ${err.message}`); });
    child.on('close', (code, signal) => {
      if (buf.trim()) for (const e of parseLine(rt.parser, buf, state)) emit(e.kind, e.text);
      live.delete(key);
      const ok = code === 0 && !state.isError;
      const limit = ok ? null : detectLimit(`${state.isError ? state.result : ''}\n${errText}`);
      if (limit) {
        emit('limit', `${runtimeName} usage limit: ${limit.message}`);
        try { setLimit(runtimeName, { ...limit, agent: inst.id }); } catch {}
      }
      emit('end', signal ? `stopped (${signal})` : `exit ${code}`);
      const summary = (limit ? `Usage limit: ${limit.message}` : state.result || lastText || errText.split('\n').filter(Boolean).pop() || `exit ${code}`).slice(0, 200);
      const patch = isChat
        ? { chat_status: 'idle', chat_pid: null }
        : { status: ok ? 'idle' : limit ? 'limited' : signal ? 'idle' : 'error', current_task: null, agent_pid: null, asked_by: null, last_message: signal ? 'stopped' : summary, ...(state.sessionId ? { task_session: state.sessionId } : {}) };
      try { setAgent(inst.id, patch); } catch {}
      resolve({ ok, code, signal, sessionId: state.sessionId, result: state.result || lastText || errText.trim(), runId, runtime: runtimeName, limited: !!limit, limit });
    });
  });
}

// Kill a process and its children (it was spawned in its own group).
export function killTree(pid, sig = 'SIGTERM') {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, sig);
    return true;
  } catch {
    try { process.kill(pid, sig); return true; } catch { return false; }
  }
}

export function stopAgent(agentId, which = 'both') {
  let stopped = false;
  const keys = which === 'chat' ? [`${agentId}:chat`] : which === 'task' ? [agentId] : [agentId, `${agentId}:chat`];
  for (const key of keys) {
    const c = live.get(key);
    if (c) stopped = killTree(c.pid) || stopped;
  }
  return stopped;
}

export function stopAll() {
  for (const c of live.values()) killTree(c.pid);
}

export function isBusy(agentId) {
  return live.has(agentId) || getAgents()[agentId]?.status === 'running';
}
