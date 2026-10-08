#!/usr/bin/env node
// Local dashboard server. Zero dependencies, binds to 127.0.0.1 only.
//   node harness/server.mjs      -> http://127.0.0.1:4317
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, P, ensureState, loadConfig, mutateConfig, readJson, writeJson, getTasks, getIssues, getAgents, addTask, updateTask,
  addIssue, updateIssue, retryTask, readActivity, listRoles, loadRole, logActivity, mutate, now, pidAlive, runtimeOf,
  getLimits, clearLimit, getHealth, setHealth, setAgent, setAgentsRuntime, limitPolicy, boardBlockers, createBugTasks, readDoc, bugReportPath, listSkills, syncSkills, roleSkills, chatIndex, mutateChatIndex, newChat, currentChat, chatMessages, appendChat,
} from './lib/store.mjs';
import { runAgent, stopAgent, killTree, checkRuntime, isChecking, maybeProbeLimits, restoreHomeRuntimes } from './lib/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
ensureState();
// Never let one bad file read or a crashed child take the dashboard down.
const logErr = (where, e) => { try { fs.appendFileSync(P.serverLog, `${now()} [${where}] ${e?.stack || e}\n`); } catch {} console.error(`[dashboard] ${where}: ${e?.message || e}`); };
process.on('uncaughtException', (e) => logErr('uncaught', e));
process.on('unhandledRejection', (e) => logErr('rejection', e));
try { syncSkills(); } catch (e) { logErr('skills', e); }
const PORT = Number(process.env.HARNESS_PORT || loadConfig().dashboard?.port || 4317);
const HOST = '127.0.0.1';

// ---------- helpers ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const body = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
});
const fail = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };

// Is each runtime's command installed? Checked at start and every minute.
const installed = {};
function checkRuntimes() {
  for (const [name, rt] of Object.entries(loadConfig().runtimes || {})) {
    const r = process.platform === 'win32'
      ? spawnSync('where', [rt.cmd], { stdio: 'ignore' })
      : spawnSync('sh', ['-c', `command -v "${rt.cmd}"`], { stdio: 'ignore' });
    installed[name] = r.status === 0;
  }
}
checkRuntimes();
setInterval(checkRuntimes, 60000);

function loopState() {
  const l = readJson(P.loop);
  if (l.status !== 'stopped' && l.pid && !pidAlive(l.pid)) return { ...l, status: 'stopped', reason: l.reason || 'loop process exited' };
  return l;
}

function jobs() {
  const out = {};
  for (const f of fs.readdirSync(P.jobs)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = readJson(path.join(P.jobs, f));
      out[j.task] = { ...j, alive: j.status !== 'stopped' && pidAlive(j.pid) };
    } catch {}
  }
  return out;
}

function snapshot() {
  const cfg = loadConfig();
  const rt = getAgents();
  const limits = getLimits();
  const health = getHealth();
  const agents = cfg.agents.map((a) => {
    let description = '';
    try { description = loadRole(a.role).meta.description || ''; } catch {}
    const runtime = runtimeOf(cfg, a);
    const st = rt[a.id] || {};
    const running = st.status === 'running' && pidAlive(st.owner_pid);
    return {
      ...st, id: a.id, role: a.role, model: a.model || '', enabled: a.enabled !== false, runtime, description,
      status: a.enabled === false ? 'disabled' : running ? 'running'
        : st.status === 'running' || (st.status === 'limited' && !limits[runtime]) ? 'idle' : st.status || 'idle',
      home_runtime: a.home_runtime || null,
      skills: (() => { try { return roleSkills(loadRole(a.role).meta); } catch { return []; } })(),
      limited: limits[runtime] || null,
      setup: health[runtime]?.ok === false ? health[runtime] : null,
    };
  });
  const runtimes = Object.entries(cfg.runtimes).map(([name, r]) => ({
    name, label: r.label || name, cmd: r.cmd, installed: !!installed[name], limited: limits[name] || null,
    can_resume: !!r.resume_args, note: r.note || '', models: r.models || [{ id: '', label: 'Default' }],
    health: health[name] ? { ...health[name], checking: isChecking(name) } : (isChecking(name) ? { checking: true } : null),
  }));
  return {
    project: cfg.project || path.basename(ROOT),
    tasks: getTasks(), issues: getIssues(), agents, runtimes, limits, jobs: jobs(), loop: loopState(),
    settings: { default_runtime: cfg.default_runtime, loop: cfg.loop || {}, schedule: cfg.schedule || { enabled: false } },
    schedule_state: readSchedState(),
    limit_policy: limitPolicy(cfg),
    blockers: boardBlockers(),
    activity: readActivity(150), roles: listRoles(), skills: listSkills(), at: now(),
  };
}

function recentRunEvents(agentId, limit = 150) {
  const files = fs.readdirSync(P.runs).filter((f) => f.endsWith(`_${agentId}.jsonl`)).sort().slice(-5);
  const evs = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(P.runs, f), 'utf8').split('\n')) {
      if (!l) continue;
      try { evs.push(JSON.parse(l)); } catch {}
    }
  }
  return evs.filter((e) => e.mode !== 'chat').slice(-limit);
}

// ---------- SSE: poll files, push changes ----------
const clients = new Set();
const broadcast = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
};
const mtimes = {};
const offsets = {};
for (const f of fs.readdirSync(P.runs)) if (f.endsWith('.jsonl')) offsets[f] = fs.statSync(path.join(P.runs, f)).size;

function watchedFiles() {
  const list = [P.tasks, P.issues, P.agents, P.loop, P.activity, P.limits, P.health, P.config, path.join(P.jobs, '..', 'schedule.json')];
  for (const f of fs.readdirSync(P.jobs)) list.push(path.join(P.jobs, f));
  return list;
}
let jobCount = 0;
setInterval(() => { try { watchTick(); } catch (e) { logErr('watch', e); } }, 700);
function watchTick() {
  let changed = false;
  const files = watchedFiles();
  if (files.length !== jobCount) { jobCount = files.length; changed = true; }
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (mtimes[f] !== m) { mtimes[f] = m; changed = true; }
    } catch {}
  }
  if (changed && clients.size) broadcast('state', snapshot());
  for (const f of fs.readdirSync(P.runs)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(P.runs, f);
    const size = fs.statSync(full).size;
    const off = offsets[f] || 0;
    if (size <= off) continue;
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    fs.closeSync(fd);
    const text = buf.toString();
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) continue;
    offsets[f] = off + Buffer.byteLength(text.slice(0, lastNl + 1));
    for (const l of text.slice(0, lastNl).split('\n')) {
      try { broadcast('agent', JSON.parse(l)); } catch {}
    }
  }
}
setInterval(() => broadcast('ping', {}), 20000);
// Periodic refresh so limit reset times and dead processes show up without file changes.
setInterval(() => { try { if (clients.size) broadcast('state', snapshot()); } catch (e) { logErr('refresh', e); } }, 15000);

// ---------- settings ----------
// Agents paused by a limit go back to a clean idle state once it no longer applies to them.
function unpause(pred) {
  for (const a of Object.values(getAgents())) {
    if ((a.status === 'limited' || a.status === 'error' || /^(Usage limit|Cannot run)/.test(a.last_message || '')) && pred(a)) setAgent(a.id, { status: 'idle', last_message: '' });
  }
}

function agentPatch(id, patch) {
  const cfg = loadConfig();
  if (!cfg.agents.some((x) => x.id === id)) fail(`Unknown agent ${id}`);
  if (patch.runtime && !cfg.runtimes[patch.runtime]) fail(`Unknown runtime "${patch.runtime}"`);
  // Runtime first (restores the model this agent last used on that runtime), then the explicit model.
  const moved = patch.runtime ? setAgentsRuntime([id], patch.runtime, { by: 'human' }) : [];
  const a = mutateConfig((c) => {
    const x = c.agents.find((y) => y.id === id);
    if (patch.model !== undefined) { if (patch.model) x.model = patch.model; else delete x.model; }
    if (patch.enabled !== undefined) x.enabled = !!patch.enabled;
    return x;
  });
  if (moved.length) setTimeout(() => autoTest(patch.runtime), 0);
  if (patch.model !== undefined || patch.enabled !== undefined) logActivity('human', `settings: ${id} → ${runtimeOf(loadConfig(), a)}${a.model ? ` (${a.model})` : ''}${a.enabled === false ? ', disabled' : ''}`);
  return a;
}

// Apply runtime/model to every agent with a role (e.g. all implementers on Sonnet).
function rolePatch(role, patch) {
  const ids = loadConfig().agents.filter((a) => a.role === role).map((a) => a.id);
  if (!ids.length) fail(`No agents with role "${role}"`);
  for (const id of ids) agentPatch(id, patch);
  return { updated: ids };
}

function switchRuntime(from, to, ids, { setDefault = false } = {}) {
  const cfg = loadConfig();
  if (!cfg.runtimes[to]) fail(`Unknown runtime "${to}"`);
  const list = cfg.agents.filter((a) => (ids?.length ? ids.includes(a.id) : runtimeOf(cfg, a) === from)).map((a) => a.id);
  const switched = setAgentsRuntime(list, to, { by: 'human' }); // one config write for all of them
  if (setDefault) mutateConfig((c) => { c.default_runtime = to; });
  const test = autoTest(to);
  return { switched, testing: !!test };
}

// After a switch, check the new runtime once so problems show up before the loop uses it.
function autoTest(runtime) {
  const h = getHealth()[runtime];
  const fresh = h?.ok && h.checked && Date.now() - new Date(h.at).getTime() < 30 * 60 * 1000;
  if (fresh || isChecking(runtime)) return null;
  return checkRuntime(runtime).catch((e) => logErr('check', e));
}

function settingsPatch(p) {
  return mutateConfig((c) => {
    if (p.default_runtime) {
      if (!c.runtimes[p.default_runtime]) fail(`Unknown runtime "${p.default_runtime}"`);
      c.default_runtime = p.default_runtime;
    }
    if (p.project) c.project = String(p.project).slice(0, 80);
    if (p.loop) {
      c.loop = c.loop || {};
      for (const k of ['max_parallel', 'max_iterations', 'max_attempts']) if (p.loop[k] !== undefined) c.loop[k] = Math.max(1, Math.min(50, Number(p.loop[k]) || 1));
      for (const k of ['review', 'use_worktrees']) if (p.loop[k] !== undefined) c.loop[k] = !!p.loop[k];
      if (p.loop.gate_command !== undefined) c.loop.gate_command = String(p.loop.gate_command);
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      if (p.loop.max_run_minutes !== undefined) c.loop.max_run_minutes = clamp(p.loop.max_run_minutes, 0, 24 * 60);
      if (p.loop.idle_timeout_s !== undefined) c.loop.idle_timeout_s = clamp(p.loop.idle_timeout_s, 60, 6 * 3600);
      if (p.loop.turn_timeout_s !== undefined) c.loop.turn_timeout_s = clamp(p.loop.turn_timeout_s, 300, 24 * 3600);
    }
    if (p.limits) {
      const lm = { ...(c.limits || {}) };
      if (p.limits.on_limit !== undefined) { if (!['wait', 'switch', 'stop'].includes(p.limits.on_limit)) fail('on_limit must be wait, switch or stop'); lm.on_limit = p.limits.on_limit; }
      if (p.limits.fallback !== undefined) { if (p.limits.fallback !== 'auto' && !c.runtimes[p.limits.fallback]) fail(`Unknown runtime "${p.limits.fallback}"`); lm.fallback = p.limits.fallback; }
      if (p.limits.switch_back !== undefined) lm.switch_back = !!p.limits.switch_back;
      if (p.limits.probe_minutes !== undefined) lm.probe_minutes = Math.max(5, Math.min(240, Math.round(Number(p.limits.probe_minutes) || 15)));
      c.limits = lm;
    }
    if (p.schedule) {
      const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : null);
      const sc = { ...(c.schedule || {}) };
      if (p.schedule.enabled !== undefined) sc.enabled = !!p.schedule.enabled;
      if (p.schedule.start !== undefined) { if (!hhmm(p.schedule.start)) fail('Start time must be HH:MM'); sc.start = p.schedule.start; }
      if (p.schedule.stop !== undefined) sc.stop = hhmm(p.schedule.stop) || null;
      if (Array.isArray(p.schedule.days)) sc.days = [...new Set(p.schedule.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (sc.enabled && !sc.start) fail('Set a start time for the schedule');
      if (sc.enabled && !(sc.days || []).length) fail('Pick at least one day for the schedule');
      c.schedule = sc;
    }
    logActivity('human', 'updated settings');
    return { ok: true };
  });
}

// ---------- chat ----------
const chatting = new Map(); // agent -> chatId
async function chatSend(agentId, { message, chatId, runtime, model }) {
  const cfg = loadConfig();
  const inst = cfg.agents.find((a) => a.id === agentId);
  if (!inst) fail(`Unknown agent ${agentId}`);
  if (chatting.has(agentId)) fail(`${agentId} is still replying — wait or press Stop`);
  let chat = chatId ? chatIndex(agentId).chats.find((c) => c.id === chatId) : currentChat(agentId);
  if (!chat) chat = newChat(agentId, runtime || null);
  const rtName = runtime || chat.runtime || runtimeOf(cfg, inst);
  if (!cfg.runtimes[rtName]) fail(`Unknown runtime "${rtName}"`);
  // A runtime session can only be resumed by the runtime that created it.
  const canResume = !!cfg.runtimes[rtName].resume_args && chat.runtime_session && chat.session_runtime === rtName;
  const history = canResume ? [] : chatMessages(agentId, chat.id, 14);
  const chatModel = model !== undefined ? model : chat.model;
  mutateChatIndex(agentId, (ix) => { const c = ix.chats.find((x) => x.id === chat.id); if (c) { c.runtime = rtName; if (model !== undefined) c.model = model; } ix.current = chat.id; });
  const m = appendChat(agentId, chat.id, { from: 'human', text: message });
  broadcast('chat', { agent: agentId, chatId: chat.id, ...m });

  const prompt = `## Mode: chat with the human operator (local dashboard)
You are not inside a loop turn right now. Answer the operator directly and briefly.
- Questions about status: read the board with the harness CLI (task list, issue list, agents).
- Requests for work: small and safe -> do it now; anything bigger -> create tasks with
  "node harness/cli.mjs task add ..." (with --role, --priority, --accept) so the loop picks them up.
- Never claim something is done unless you verified it.
${history.length ? `\n## Earlier in this conversation\n${history.map((h) => `${h.from}: ${h.text}`).join('\n')}\n` : ''}
## Message from the operator
${message}`;
  chatting.set(agentId, chat.id);
  runAgent({ agentId, prompt, mode: 'chat', chatId: chat.id, runtime: rtName, model: chatModel ?? undefined, session: canResume ? chat.runtime_session : null })
    .then((r) => {
      const text = r.setup
        ? `${rtName} cannot run in this project yet: ${r.setup.message}\n${r.setup.hint}`
        : r.limited
        ? `${rtName} hit its usage limit: ${r.limit.message}. Pick another runtime above and send again.`
        : r.signal ? 'Stopped.'
        : r.result || (r.ok ? '(no reply text)' : `The agent exited with code ${r.code}. Check that "${cfg.runtimes[rtName].cmd}" is installed and logged in.`);
      if (r.sessionId) mutateChatIndex(agentId, (ix) => { const c = ix.chats.find((x) => x.id === chat.id); if (c) { c.runtime_session = r.sessionId; c.session_runtime = rtName; } });
      const reply = appendChat(agentId, chat.id, { from: agentId, text, ok: r.ok && !r.limited && !r.setup, runtime: rtName, model: chatModel || undefined, limited: r.limited || undefined });
      broadcast('chat', { agent: agentId, chatId: chat.id, ...reply });
    })
    .catch((e) => {
      const reply = appendChat(agentId, chat.id, { from: agentId, text: `Error: ${e.message}`, ok: false });
      broadcast('chat', { agent: agentId, chatId: chat.id, ...reply });
    })
    .finally(() => { chatting.delete(agentId); broadcast('chat-state', { agent: agentId, replying: false }); });
  return { chatId: chat.id };
}

function chatPayload(agentId, chatId) {
  const ix = chatIndex(agentId);
  const id = chatId || ix.current;
  const chat = ix.chats.find((c) => c.id === id) || null;
  return { chats: ix.chats, current: chat?.id || null, chat, messages: chat ? chatMessages(agentId, chat.id) : [], replying: chatting.get(agentId) || null };
}

function chatSave(agentId, chatId) {
  const ix = chatIndex(agentId);
  const chat = ix.chats.find((c) => c.id === (chatId || ix.current));
  if (!chat) fail('Nothing to save yet');
  const msgs = chatMessages(agentId, chat.id, 5000);
  if (!msgs.length) fail('This chat is empty');
  const slug = chat.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat';
  const dir = path.join(ROOT, 'docs', 'chat-logs');
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('docs', 'chat-logs', `${chat.created_at.slice(0, 10)}-${agentId}-${slug}.md`);
  const md = `# ${chat.title}\n\n- Agent: ${agentId}\n- Runtime: ${chat.runtime || '-'}\n- Started: ${chat.created_at}\n- Saved: ${now()}\n\n---\n\n` +
    msgs.map((m) => `### ${m.from === 'human' ? 'You' : m.from} · ${m.at.replace('T', ' ').slice(0, 16)}\n\n${m.text}\n`).join('\n');
  fs.writeFileSync(path.join(ROOT, rel), md);
  mutateChatIndex(agentId, (x) => { const c = x.chats.find((y) => y.id === chat.id); if (c) c.saved_path = rel; });
  logActivity('human', `saved chat with ${agentId} to ${rel}`);
  return { path: rel.split(path.sep).join('/'), markdown: md };
}

// ---------- runs: whole loop, one task, one issue ----------
function spawnLoop(args, logName) {
  const out = fs.openSync(path.join(P.jobs, logName), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'loop.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', out, out], detached: true });
  child.unref();
  return child.pid;
}

function startLoop(by = 'human') {
  const l = loopState();
  if (l.status !== 'stopped' && l.pid && pidAlive(l.pid)) fail('The loop is already running');
  // Don't start a loop that would stop at once: explain what blocks the board instead.
  const b = boardBlockers();
  const outside = getTasks().some((t) => t.status === 'in-progress' && pidAlive(t.owner_pid));
  if (by === 'human' && !b.ready.length && !outside) {
    if (!b.todo) fail('Nothing to do: no tasks in Todo. Add a task, or Retry a pending one.');
    const r = b.roots[0];
    fail(`Nothing can start: ${b.todo} todo task${b.todo > 1 ? 's' : ''} wait on ${b.roots.map((x) => `${x.id.replace(/^missing:/, '')} (${x.status})`).slice(0, 3).join(', ')}. ` +
      (r?.status === 'pending' ? `Answer ${r.id} and press Retry, or ▶ Run a task directly.` : 'Run a task directly, or fix its dependencies.'));
  }
  if (by === 'human') logActivity('human', 'started the loop from the dashboard');
  return { pid: spawnLoop([], 'loop.log') };
}
function stopLoop(force) {
  fs.writeFileSync(P.stop, now());
  const l = readJson(P.loop);
  if (l.pid && pidAlive(l.pid)) {
    process.kill(l.pid, 'SIGTERM');
    if (force) setTimeout(() => { try { process.kill(l.pid, 'SIGTERM'); } catch {} }, 300);
  }
  logActivity('human', force ? 'stopped the loop now' : 'asked the loop to stop after current turns');
  return { ok: true };
}

// Run one task, or a chain of tasks in order (e.g. Reproduce -> Fix), outside the board loop.
function jobFor(id) {
  return Object.values(jobs()).find((j) => j.alive && (j.task === id || (j.tasks || []).includes(id)));
}
function runTask(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  for (const id of list) {
    const t = getTasks().find((x) => x.id === id);
    if (!t) fail(`Task ${id} not found`);
    if (jobFor(id)) fail(`${id} is already running`);
    const busy = Object.values(getAgents()).some((a) => a.current_task === id && a.status === 'running' && pidAlive(a.owner_pid));
    if (busy) fail(`${id} is already being worked on by the loop`);
  }
  const todo = list.filter((id) => getTasks().find((x) => x.id === id)?.status !== 'done');
  if (!todo.length) fail(`${list.join(', ')} already done`);
  const key = todo[0];
  fs.writeFileSync(path.join(P.jobs, `${key}.json`), JSON.stringify({ task: key, tasks: todo, current: key, status: 'starting', started_at: now() }));
  const pid = spawnLoop(['--task', todo.join(',')], `${key}.log`);
  mutate(path.join(P.jobs, `${key}.json`), (d) => { d.pid = pid; });
  logActivity('human', `started a run of ${todo.join(' → ')}`, { ref: key });
  return { pid, tasks: todo };
}

function stopTask(id) {
  const t = getTasks().find((x) => x.id === id);
  if (!t) fail(`Task ${id} not found`);
  let stopped = false;
  if (t.status === 'in-progress') {
    mutate(P.tasks, (db) => { const x = db.tasks.find((y) => y.id === id); if (x) x.stop_requested = true; });
  }
  for (const a of Object.values(getAgents())) {
    if (a.current_task === id && a.agent_pid) stopped = killTree(a.agent_pid) || stopped;
  }
  const j = jobFor(id);
  if (j) { try { process.kill(j.pid, 'SIGTERM'); stopped = true; } catch {} }
  // Nothing alive is working on it: just park it.
  if (!stopped && t.status === 'in-progress') {
    updateTask(id, { status: 'pending', assignee: null, loop_owned: false, owner_pid: null, stop_requested: false, pending_reason: 'Stopped by you — press Retry or Run to continue' }, 'human', 'Stopped from the dashboard.');
  }
  logActivity('human', `stopped ${id}`, { ref: id });
  return { stopped };
}

function retryAndRun(id, note) {
  retryTask(id, 'human', note);
  const l = loopState();
  if (l.status === 'running' && pidAlive(l.pid)) return { queued: true }; // the loop will pick it up
  return { ...runTask(id), queued: false };
}

function runIssue(issueId, { repro = true } = {}) {
  const { fix, repro: r } = createBugTasks(issueId, { repro }, 'human');
  const chain = [r?.status !== 'done' ? r?.id : null, fix.id].filter(Boolean);
  const l = loopState();
  if (l.status === 'running' && pidAlive(l.pid)) return { tasks: chain, queued: true }; // the loop will run them in order
  return { ...runTask(chain), queued: false };
}

// ---------- schedule: start/stop the board loop at set times (local time of this computer) ----------
const SCHED = path.join(P.jobs, '..', 'schedule.json');
function readSchedState() { try { return readJson(SCHED); } catch { return {}; } }
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function scheduleTick() {
  const sc = loadConfig().schedule;
  if (!sc?.enabled || !sc.start) return;
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const today = localDate(d);
  const st = readSchedState();
  const running = (() => { const l = loopState(); return l.status !== 'stopped' && l.pid && pidAlive(l.pid); })();
  // Start within 5 minutes after the start time, once per day, on the chosen weekdays.
  const startMin = minutesOf(sc.start);
  if ((sc.days || []).includes(d.getDay()) && nowMin >= startMin && nowMin < startMin + 5 && st.last_start !== today) {
    writeJson(SCHED, { ...st, last_start: today });
    if (!running) {
      logActivity('schedule', `starting the loop (scheduled ${sc.start})`);
      try { startLoop('schedule'); } catch (e) { logErr('schedule', e); }
    }
  }
  // Stop (gracefully) within 5 minutes after the stop time, once per day.
  if (sc.stop) {
    const stopMin = minutesOf(sc.stop);
    if (nowMin >= stopMin && nowMin < stopMin + 5 && st.last_stop !== today) {
      writeJson(SCHED, { ...readSchedState(), last_stop: today });
      if (running) { logActivity('schedule', `stopping the loop (scheduled ${sc.stop}); current turns will finish`); stopLoop(false); }
    }
  }
}
setInterval(() => { try { scheduleTick(); } catch (e) { logErr('schedule', e); } }, 20000);
// Re-check limited runtimes without a known reset time, and move auto-switched agents home.
setInterval(() => {
  maybeProbeLimits().catch((e) => logErr('probe', e));
  try { restoreHomeRuntimes(); } catch (e) { logErr('restore', e); }
}, 30000);
setTimeout(() => { try { scheduleTick(); } catch (e) { logErr('schedule', e); } }, 2000);

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'dashboard', 'index.html')), 'text/html; charset=utf-8');
    }
    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
    const [, a, b, c] = parts;
    const M = req.method;

    if (M === 'GET' && a === 'state') return send(res, 200, snapshot());
    if (M === 'GET' && a === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (M === 'GET' && a === 'runs' && b) return send(res, 200, recentRunEvents(b));

    // settings
    if (M === 'PATCH' && a === 'agents' && b) return send(res, 200, agentPatch(b, await body(req)));
    if (M === 'POST' && a === 'agents' && b && c === 'stop') return send(res, 200, { stopped: stopAgent(b, 'task') || killTree(getAgents()[b]?.agent_pid) });
    if (M === 'PATCH' && a === 'settings') return send(res, 200, settingsPatch(await body(req)));
    if (M === 'PATCH' && a === 'roles' && b) return send(res, 200, rolePatch(b, await body(req)));
    if (M === 'POST' && a === 'runtimes' && b === 'switch') { const x = await body(req); return send(res, 200, switchRuntime(x.from, x.to, x.all ? loadConfig().agents.map((y) => y.id) : x.agents, { setDefault: !!x.all })); }
    if (M === 'POST' && a === 'runtimes' && b && c === 'test') {
      if (!loadConfig().runtimes[b]) fail(`Unknown runtime "${b}"`);
      checkRuntime(b).catch((e) => logErr('check', e));
      return send(res, 202, { checking: true });
    }
    if (M === 'POST' && a === 'runtimes' && b && c === 'clear-limit') {
      clearLimit(b);
      const cfg = loadConfig();
      unpause((x) => { const inst = cfg.agents.find((y) => y.id === x.id); return inst && runtimeOf(cfg, inst) === b; });
      return send(res, 200, { ok: true });
    }

    // chat
    if (a === 'chat' && b) {
      if (M === 'GET') return send(res, 200, chatPayload(b, url.searchParams.get('chat')));
      const x = await body(req);
      if (M === 'POST' && c === 'send') {
        if (!x.message?.trim()) fail('Message is empty');
        return send(res, 202, await chatSend(b, { ...x, message: x.message.trim() }));
      }
      if (M === 'POST' && c === 'new') { newChat(b, x.runtime || null); return send(res, 201, chatPayload(b)); }
      if (M === 'POST' && c === 'select') { mutateChatIndex(b, (ix) => { if (ix.chats.some((y) => y.id === x.chatId)) ix.current = x.chatId; }); return send(res, 200, chatPayload(b)); }
      if (M === 'POST' && c === 'save') return send(res, 200, chatSave(b, x.chatId));
      if (M === 'POST' && c === 'stop') return send(res, 200, { stopped: stopAgent(b, 'chat') || killTree(getAgents()[b]?.chat_pid) });
      if (M === 'POST' && c === 'runtime') {
        mutateChatIndex(b, (ix) => { const ch = ix.chats.find((y) => y.id === (x.chatId || ix.current)); if (ch) { if (x.runtime !== undefined) { if (ch.runtime !== x.runtime) ch.model = null; ch.runtime = x.runtime; } if (x.model !== undefined) ch.model = x.model; } });
        return send(res, 200, chatPayload(b));
      }
    }

    // tasks
    if (M === 'POST' && a === 'tasks' && !b) return send(res, 201, addTask(await body(req), 'human'));
    if (M === 'POST' && a === 'tasks' && b && c === 'run') return send(res, 200, runTask(b));
    if (M === 'POST' && a === 'tasks' && b && c === 'stop') return send(res, 200, stopTask(b));
    if (M === 'POST' && a === 'tasks' && b && c === 'retry') { const x = await body(req); return send(res, 200, retryAndRun(b, x.note)); }
    if (M === 'PATCH' && a === 'tasks' && b) {
      const { note, ...patch } = await body(req);
      const before = getTasks().find((t) => t.id === b);
      if (patch.status === 'todo' && before?.status === 'pending') return send(res, 200, retryTask(b, 'human', note));
      if (patch.status === 'todo') Object.assign(patch, { submitted: false, pending_reason: null, assignee: null, review: null });
      return send(res, 200, updateTask(b, patch, 'human', note));
    }

    // issues
    if (M === 'POST' && a === 'issues' && !b) return send(res, 201, addIssue(await body(req), 'human'));
    if (M === 'POST' && a === 'issues' && b && c === 'run') { const x = await body(req); return send(res, 200, runIssue(b, { repro: x.repro !== false })); }
    if (M === 'POST' && a === 'issues' && b && c === 'stop') {
      const i = getIssues().find((x) => x.id === b);
      const ids = [i?.repro_task, i?.fix_task].filter(Boolean);
      const running = ids.find((id) => getTasks().find((t) => t.id === id)?.status === 'in-progress' || jobFor(id)) || ids[0];
      if (!running) fail(`${b} has no running fix`);
      return send(res, 200, stopTask(running));
    }
    if (M === 'GET' && a === 'doc') {
      const rel = url.searchParams.get('path') || '';
      const text = readDoc(rel, 60000);
      if (text === null) fail(`Not found (only files under docs/ can be shown): ${rel}`);
      return send(res, 200, { path: rel, text });
    }
    if (M === 'PATCH' && a === 'issues' && b) {
      const { note, ...patch } = await body(req);
      return send(res, 200, updateIssue(b, patch, 'human', note));
    }

    // loop
    if (M === 'POST' && a === 'loop' && b === 'start') return send(res, 200, startLoop());
    if (M === 'POST' && a === 'loop' && b === 'stop') { const x = await body(req); return send(res, 200, stopLoop(!!x.force)); }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.status || 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[dashboard] Port ${PORT} is busy. Is the dashboard already open? Or set HARNESS_PORT=4318.`);
  else console.error(`[dashboard] ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`[dashboard] ${loadConfig().project || 'project'} → http://${HOST}:${PORT}`);
});
