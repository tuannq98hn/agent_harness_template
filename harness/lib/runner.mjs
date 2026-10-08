// Spawns an agent CLI (Claude Code, Codex, or anything else) for one turn,
// parses its output into readable events, records a run log, detects usage limits,
// and keeps the agent's runtime state (running/idle, current task, last message) current.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  ROOT, P, loadConfig, loadRole, setAgent, getAgents, setLimit, getLimits, clearLimit, mutate, runtimeOf, setHealth, getHealth,
  listSkills, roleSkills, parseReset, limitPolicy, setAgentsRuntime, logActivity, now,
} from './store.mjs';

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
  let resets_at = parseReset(text);
  // Ignore reset times in the past or absurdly far away; the harness then re-checks periodically.
  if (resets_at) { const dt = Date.parse(resets_at) - Date.now(); if (dt < 30000 || dt > 8 * 864e5) resets_at = null; }
  return { message: line.replace(/\|\d{10}/, '').trim().slice(0, 300), resets_at };
}

// Messages a CLI prints when it was never set up for this folder/user. Only checked on failure.
const SETUP_RE = /trusted directory|trust (this|the) (folder|directory)|skip-git-repo-check|not logged in|please (run )?(\/)?log ?in|login required|authenticat|unauthori[sz]ed|\b401\b|invalid api key|api key|codex login|claude login|onboarding|not found on PATH|ENOENT/i;

export function setupHint(runtimeName, cmd) {
  if (/codex/i.test(`${runtimeName} ${cmd}`)) return 'Open a terminal in this project folder and run "codex" once: trust the folder and log in if asked. Then press Test again.';
  if (/claude/i.test(`${runtimeName} ${cmd}`)) return 'Open a terminal in this project folder and run "claude" once: accept the folder trust prompt and log in (/login) if asked. Then press Test again.';
  return `Run "${cmd}" once in this project folder to finish its setup, then press Test again.`;
}

export function detectSetup(text) {
  if (!text || !SETUP_RE.test(text)) return null;
  const line = text.split('\n').find((l) => SETUP_RE.test(l)) || text;
  return { message: line.trim().slice(0, 300) };
}

function skillsSection(meta) {
  const all = listSkills();
  if (!all.length) return '';
  const mine = roleSkills(meta).map((n) => all.find((s) => s.name === n || s.dir === n)).filter(Boolean);
  const others = all.filter((s) => !mine.includes(s));
  return `\n## Skills
Skills are short how-tos in .agents/skills/<name>/SKILL.md. Before work that matches a skill, read that
file and follow it. Your runtime may also load them automatically.
${mine.length ? `Recommended for your role:\n${mine.map((s) => `- ${s.name} — ${s.description}`).join('\n')}\n` : ''}${others.length ? `Also available: ${others.map((s) => s.name).join(', ')} (node harness/cli.mjs skills list)\n` : ''}`;
}

export function buildSystemPrompt(agentId, role) {
  const def = loadRole(role);
  return `You are agent "${agentId}" with role "${role}" in a multi-agent software project.\n` +
    `Read AGENTS.md first, then follow your role rules below.\n\n${def.body.trim()}\n${skillsSection(def.meta)}${CONTRACT}`;
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
 * @param {string} [o.model]   override the model ('' = runtime default)
 * @param {string} [o.mode]    'task' | 'chat'
 * @param {string} [o.chatId]  chat session id (chat mode)
 * @param {string} [o.cwd]     working directory (e.g. a git worktree)
 * @param {string} [o.caller]  agent that asked for this run ('ask' mode)
 * @param {number} [o.depth]   nesting depth of agent-to-agent calls
 * @param {string} [o.tools]   override the allowed tool list (e.g. read-only asks)
 * @param {number} [o.timeoutS] kill the run after this many seconds (default loop.turn_timeout_s)
 * @param {number} [o.idleS]    kill the run after this many seconds without any output (default loop.idle_timeout_s)
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
    model: (o.model !== undefined && o.model !== null ? o.model : (!o.runtime || o.runtime === runtimeOf(cfg, inst) ? inst.model : '')) || rt.default_model || '',
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
    let events = 0;      // parsed stdout events (proof the CLI actually started working)
    let timedOut = null; // 'idle' | 'total'
    const L = cfg.loop || {};
    const idleS = Number(o.idleS ?? L.idle_timeout_s ?? 300);
    const totalS = Number(o.timeoutS ?? L.turn_timeout_s ?? 3600);
    let idleTimer;
    const bump = () => {
      clearTimeout(idleTimer);
      if (idleS > 0) idleTimer = setTimeout(() => { timedOut = 'idle'; killTree(child.pid); }, idleS * 1000);
    };
    bump();
    const totalTimer = totalS > 0 ? setTimeout(() => { timedOut = 'total'; killTree(child.pid); }, totalS * 1000) : null;
    child.stdout.on('data', (d) => {
      bump();
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        for (const e of parseLine(rt.parser, line, state)) {
          events++;
          emit(e.kind, e.text);
          if (e.kind === 'text' || e.kind === 'result') lastText = e.text;
          if (e.kind === 'error') errText += `${e.text}\n`;
          if (!isChat && (e.kind === 'text' || e.kind === 'tool')) {
            try { setAgent(inst.id, { last_message: e.text.slice(0, 200) }); } catch {}
          }
        }
      }
    });
    child.stderr.on('data', (d) => { bump(); const t = d.toString(); errText = (errText + t).slice(-4000); emit('stderr', t.slice(0, 2000)); });
    child.on('error', (err) => { errText += err.code === 'ENOENT' ? `"${rt.cmd}" not found on PATH\n` : `${err.message}\n`; emit('error', err.code === 'ENOENT' ? `"${rt.cmd}" is not installed or not on PATH` : `spawn failed: ${err.message}`); });
    child.on('close', (code, signal) => {
      clearTimeout(idleTimer); clearTimeout(totalTimer);
      if (buf.trim()) for (const e of parseLine(rt.parser, buf, state)) { events++; emit(e.kind, e.text); }
      live.delete(key);
      const ok = code === 0 && !state.isError && !timedOut;
      const failText = `${state.result || lastText || ''}\n${errText}`;
      const limit = ok ? null : detectLimit(failText);
      if (limit) {
        emit('limit', `${runtimeName} usage limit: ${limit.message}`);
        try { setLimit(runtimeName, { ...limit, agent: inst.id }); } catch {}
      }
      // "Cannot run here yet": a setup message, or the CLI died/stalled before producing anything.
      let setup = null;
      if (!ok && !limit && !(signal && !timedOut)) {
        setup = detectSetup(failText);
        if (!setup && events === 0) {
          setup = timedOut
            ? { message: `${rt.cmd} printed nothing for ${idleS}s — it is probably waiting for an interactive answer (first run in this folder, trust or login).` }
            : { message: (errText.trim().split('\n').filter(Boolean).pop() || `${rt.cmd} exited with code ${code} before doing anything`).slice(0, 300) };
        }
        if (setup) {
          setup.hint = setupHint(runtimeName, rt.cmd);
          emit('setup', `${runtimeName} cannot run here: ${setup.message}`);
          try { setHealth(runtimeName, { ok: false, ...setup, agent: inst.id }); } catch {}
        }
      }
      if (ok && getHealth()[runtimeName]?.ok === false) { try { setHealth(runtimeName, { ok: true }); } catch {} }
      if (timedOut && !setup) emit('error', timedOut === 'idle' ? `no output for ${idleS}s — stopped` : `turn exceeded ${totalS}s — stopped`);
      emit('end', timedOut ? `timed out (${timedOut})` : signal ? `stopped (${signal})` : `exit ${code}`);
      const summary = (limit ? `Usage limit: ${limit.message}` : setup ? `Cannot run: ${setup.message}` : state.result || lastText || errText.split('\n').filter(Boolean).pop() || `exit ${code}`).slice(0, 200);
      const patch = isChat
        ? { chat_status: 'idle', chat_pid: null }
        : { status: ok ? 'idle' : limit ? 'limited' : setup ? 'error' : signal && !timedOut ? 'idle' : 'error', current_task: null, agent_pid: null, asked_by: null, last_message: signal && !timedOut ? 'stopped' : summary, ...(state.sessionId ? { task_session: state.sessionId } : {}) };
      try { setAgent(inst.id, patch); } catch {}
      resolve({ ok, code, signal: timedOut ? null : signal, timedOut, sessionId: state.sessionId, result: state.result || lastText || errText.trim(), runId, runtime: runtimeName, limited: !!limit, limit, setup });
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

// Quick "can this runtime run in this project?" check: one tiny prompt, short timeouts.
const checking = new Map();
export function checkRuntime(runtimeName, opts = {}) {
  if (checking.has(runtimeName)) return checking.get(runtimeName);
  const cfg = loadConfig();
  const idleS = opts.idleS ?? Math.min(90, Number(cfg.loop?.idle_timeout_s ?? 90));
  const timeoutS = opts.timeoutS ?? 120;
  const rt = cfg.runtimes[runtimeName];
  if (!rt) return Promise.resolve({ ok: false, message: `Unknown runtime "${runtimeName}"` });
  const prompt = 'Health check from the agent harness. Reply with exactly: OK';
  const promptFile = path.join(P.runs, `check-${runtimeName}-${Date.now()}.prompt.md`);
  fs.writeFileSync(promptFile, prompt);
  const vars = { prompt, system: 'Reply with exactly: OK', full_prompt: prompt, prompt_file: promptFile, tools: '', model: '', session: '', agent: 'health-check', root: ROOT };
  const raw = fill(rt.args, vars);
  const args = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--') && raw[i + 1] === '') { i++; continue; } args.push(raw[i]); }
  try { setHealth(runtimeName, { ...(getHealth()[runtimeName] || {}), checking: true }); } catch {}
  const p = new Promise((resolve) => {
    let child;
    const state = { result: '', isError: false };
    let out = ''; let err = ''; let events = 0; let timedOut = false;
    const done = (r) => {
      checking.delete(runtimeName);
      try { fs.rmSync(promptFile, { force: true }); } catch {}
      const limit = r.ok ? null : detectLimit(`${state.result}\n${err}`);
      if (limit) { try { setLimit(runtimeName, { ...limit, agent: 'health-check', last_check: now() }); } catch {} }
      if (r.ok && getLimits()[runtimeName]) { try { clearLimit(runtimeName, 'harness'); } catch {} }
      if (!r.ok && (limit || getLimits()[runtimeName])) {
        // Still failing while limited: keep the limit, don't mark the runtime as "needs setup".
        try { mutate(P.limits, (db) => { if (db.runtimes[runtimeName]) db.runtimes[runtimeName].last_check = now(); }); } catch {}
        checking.delete(runtimeName);
        try { fs.rmSync(promptFile, { force: true }); } catch {}
        return resolve({ ok: false, checked: true, message: limit ? limit.message : r.message, limited: true });
      }
      const info = r.ok ? { ok: true, checked: true }
        : { ok: false, checked: true, message: limit ? `usage limit: ${limit.message}` : r.message, hint: limit ? 'Wait for the reset or switch to another runtime.' : setupHint(runtimeName, rt.cmd) };
      try { setHealth(runtimeName, info); } catch {}
      resolve(info);
    };
    try {
      child = spawn(rt.cmd, args, { cwd: ROOT, env: { ...process.env, HARNESS_ROOT: ROOT, HARNESS_RUNTIME: runtimeName, HARNESS_AGENT: 'health-check' }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    } catch (e) { return done({ ok: false, message: e.message }); }
    let idle = setTimeout(() => { timedOut = true; killTree(child.pid); }, idleS * 1000);
    const total = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutS * 1000);
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; killTree(child.pid); }, idleS * 1000); };
    child.stdout.on('data', (d) => { bump(); out += d.toString(); });
    child.stderr.on('data', (d) => { bump(); err = (err + d.toString()).slice(-3000); });
    child.on('error', (e) => { err += e.code === 'ENOENT' ? `"${rt.cmd}" not found on PATH` : e.message; });
    child.on('close', (code) => {
      clearTimeout(idle); clearTimeout(total);
      for (const line of out.split('\n')) { const evs = parseLine(rt.parser, line, state); events += evs.length; }
      if (timedOut) return done({ ok: false, message: events ? `${rt.cmd} did not finish within ${timeoutS}s` : `${rt.cmd} printed nothing for ${idleS}s — probably waiting for an interactive answer (trust this folder / log in).` });
      if (code === 0 && !state.isError) return done({ ok: true });
      const setup = detectSetup(`${state.result}\n${err}`);
      done({ ok: false, message: (setup?.message || err.trim().split('\n').filter(Boolean).pop() || state.result || `exit ${code}`).slice(0, 300) });
    });
  });
  checking.set(runtimeName, p);
  return p;
}
export const isChecking = (name) => checking.has(name);

// ---------- Limits: periodic re-check and automatic switch-back ----------
// Runs in the dashboard and in the loop; a claim in limits.json makes sure only one process probes.
export async function maybeProbeLimits() {
  const pol = limitPolicy();
  const due = [];
  try {
    mutate(P.limits, (db) => {
      const t = Date.now();
      for (const [name, l] of Object.entries(db.runtimes)) {
        if (l.resets_at && Date.parse(l.resets_at) > t) continue;         // known reset time: just wait for it
        const last = Date.parse(l.last_check || l.at || 0) || 0;
        if (t - last < pol.probe_minutes * 60000) continue;
        l.last_check = new Date(t).toISOString();                        // claim
        due.push(name);
      }
    });
  } catch { return []; }
  const results = [];
  for (const name of due) {
    logActivity('harness', `checking whether ${name} is available again`);
    results.push({ name, ...(await checkRuntime(name)) });
  }
  return results;
}

// Agents that the limit policy moved away go back to their home runtime once it is available.
export function restoreHomeRuntimes() {
  const pol = limitPolicy();
  if (!pol.switch_back) return [];
  const cfg = loadConfig();
  const limits = getLimits();
  const health = getHealth();
  const groups = {};
  for (const a of cfg.agents) {
    if (!a.home_runtime || a.home_runtime === runtimeOf(cfg, a)) continue;
    if (limits[a.home_runtime] || health[a.home_runtime]?.ok === false) continue;
    (groups[a.home_runtime] = groups[a.home_runtime] || []).push(a.id);
  }
  const moved = [];
  for (const [home, ids] of Object.entries(groups)) {
    moved.push(...setAgentsRuntime(ids, home, { by: 'harness' }));
    logActivity('harness', `${home} is available again — moved ${ids.join(', ')} back`);
  }
  return moved;
}

// Pick the runtime the limit policy switches to.
export function fallbackRuntime(from) {
  const cfg = loadConfig();
  const pol = limitPolicy(cfg);
  const limits = getLimits();
  const health = getHealth();
  const ok = (n) => n && n !== from && cfg.runtimes[n] && !limits[n] && health[n]?.ok !== false;
  if (pol.fallback !== 'auto') return ok(pol.fallback) ? pol.fallback : null;
  return Object.keys(cfg.runtimes).find((n) => n !== 'mock' && ok(n)) || null;
}
