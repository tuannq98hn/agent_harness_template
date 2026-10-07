#!/usr/bin/env node
// Local dashboard server. Zero dependencies, binds to 127.0.0.1 only.
//   node harness/server.mjs      -> http://127.0.0.1:4317
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, P, ensureState, loadConfig, mutateConfig, readJson, getTasks, getIssues, getAgents, addTask, updateTask,
  addIssue, updateIssue, retryTask, readActivity, listRoles, loadRole, logActivity, mutate, now, pidAlive, runtimeOf,
  getLimits, clearLimit, setAgent, chatIndex, mutateChatIndex, newChat, currentChat, chatMessages, appendChat,
} from './lib/store.mjs';
import { runAgent, stopAgent, killTree } from './lib/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
ensureState();
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
      limited: limits[runtime] || null,
    };
  });
  const runtimes = Object.entries(cfg.runtimes).map(([name, r]) => ({
    name, label: r.label || name, cmd: r.cmd, installed: !!installed[name], limited: limits[name] || null,
    can_resume: !!r.resume_args, note: r.note || '',
  }));
  return {
    project: cfg.project || path.basename(ROOT),
    tasks: getTasks(), issues: getIssues(), agents, runtimes, limits, jobs: jobs(), loop: loopState(),
    settings: { default_runtime: cfg.default_runtime, loop: cfg.loop || {} },
    activity: readActivity(150), roles: listRoles(), at: now(),
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
  const list = [P.tasks, P.issues, P.agents, P.loop, P.activity, P.limits, P.config];
  for (const f of fs.readdirSync(P.jobs)) list.push(path.join(P.jobs, f));
  return list;
}
let jobCount = 0;
setInterval(() => {
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
}, 700);
setInterval(() => broadcast('ping', {}), 20000);
// Periodic refresh so limit reset times and dead processes show up without file changes.
setInterval(() => { if (clients.size) broadcast('state', snapshot()); }, 15000);

// ---------- settings ----------
// Agents paused by a limit go back to a clean idle state once it no longer applies to them.
function unpause(pred) {
  for (const a of Object.values(getAgents())) {
    if ((a.status === 'limited' || /^Usage limit/.test(a.last_message || '')) && pred(a)) setAgent(a.id, { status: 'idle', last_message: '' });
  }
}

function agentPatch(id, patch) {
  const cfg = loadConfig();
  if (patch.runtime && !cfg.runtimes[patch.runtime]) fail(`Unknown runtime "${patch.runtime}"`);
  return mutateConfig((c) => {
    const a = c.agents.find((x) => x.id === id);
    if (!a) fail(`Unknown agent ${id}`);
    const before = runtimeOf(c, a);
    if (patch.runtime !== undefined) a.runtime = patch.runtime;
    if (patch.model !== undefined) { if (patch.model) a.model = patch.model; else delete a.model; }
    if (patch.runtime && patch.runtime !== before && patch.model === undefined) delete a.model; // models are runtime-specific
    if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
    if (patch.runtime && patch.runtime !== before) setTimeout(() => unpause((x) => x.id === id), 0);
    logActivity('human', `settings: ${id} → ${runtimeOf(c, a)}${a.model ? ` (${a.model})` : ''}${a.enabled === false ? ', disabled' : ''}`);
    return a;
  });
}

function switchRuntime(from, to, ids) {
  const cfg = loadConfig();
  if (!cfg.runtimes[to]) fail(`Unknown runtime "${to}"`);
  const targets = cfg.agents.filter((a) => (ids?.length ? ids.includes(a.id) : runtimeOf(cfg, a) === from));
  for (const a of targets) agentPatch(a.id, { runtime: to });
  return { switched: targets.map((a) => a.id) };
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
    }
    logActivity('human', 'updated settings');
    return { ok: true };
  });
}

// ---------- chat ----------
const chatting = new Map(); // agent -> chatId
async function chatSend(agentId, { message, chatId, runtime }) {
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
  mutateChatIndex(agentId, (ix) => { const c = ix.chats.find((x) => x.id === chat.id); if (c) c.runtime = rtName; ix.current = chat.id; });
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
  runAgent({ agentId, prompt, mode: 'chat', chatId: chat.id, runtime: rtName, session: canResume ? chat.runtime_session : null })
    .then((r) => {
      const text = r.limited
        ? `${rtName} hit its usage limit: ${r.limit.message}. Pick another runtime above and send again.`
        : r.signal ? 'Stopped.'
        : r.result || (r.ok ? '(no reply text)' : `The agent exited with code ${r.code}. Check that "${cfg.runtimes[rtName].cmd}" is installed and logged in.`);
      if (r.sessionId) mutateChatIndex(agentId, (ix) => { const c = ix.chats.find((x) => x.id === chat.id); if (c) { c.runtime_session = r.sessionId; c.session_runtime = rtName; } });
      const reply = appendChat(agentId, chat.id, { from: agentId, text, ok: r.ok && !r.limited, runtime: rtName, limited: r.limited || undefined });
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

function startLoop() {
  const l = loopState();
  if (l.status !== 'stopped' && l.pid && pidAlive(l.pid)) fail('The loop is already running');
  logActivity('human', 'started the loop from the dashboard');
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

function runTask(id) {
  const t = getTasks().find((x) => x.id === id);
  if (!t) fail(`Task ${id} not found`);
  if (t.status === 'done') fail(`${id} is already done`);
  const j = jobs()[id];
  if (j?.alive) fail(`${id} is already running`);
  const busy = Object.values(getAgents()).some((a) => a.current_task === id && a.status === 'running' && pidAlive(a.owner_pid));
  if (busy) fail(`${id} is already being worked on by the loop`);
  fs.writeFileSync(path.join(P.jobs, `${id}.json`), JSON.stringify({ task: id, status: 'starting', started_at: now() }));
  const pid = spawnLoop(['--task', id], `${id}.log`);
  mutate(path.join(P.jobs, `${id}.json`), (d) => { d.pid = pid; });
  logActivity('human', `started a run of ${id}`, { ref: id });
  return { pid };
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
  const j = jobs()[id];
  if (j?.alive) { try { process.kill(j.pid, 'SIGTERM'); stopped = true; } catch {} }
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

const SEV_PRIO = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
function fixTaskFor(issueId) {
  const i = getIssues().find((x) => x.id === issueId);
  if (!i) fail(`Issue ${issueId} not found`);
  if (i.type === 'blocker' && i.task) fail(`${i.id} is a question on ${i.task}. Answer it on the task, then Retry ${i.task}.`);
  const existing = i.fix_task && getTasks().find((t) => t.id === i.fix_task);
  if (existing && existing.status !== 'done') return existing;
  const t = addTask({
    title: `Fix ${i.id}: ${i.title}`,
    description: `${i.description || ''}\n\nRelated task: ${i.task || '-'}`.trim(),
    role: i.type === 'risk' || i.type === 'question' ? 'implementer' : 'implementer',
    priority: SEV_PRIO[i.severity] || 'P2',
    acceptance: [`${i.id} no longer reproduces`, 'Regression test added where practical', 'Root cause noted in the task'],
  }, 'human');
  updateTask(t.id, { issue_ref: i.id }, 'human');
  updateIssue(i.id, { fix_task: t.id, status: 'in-progress' }, 'human', `Fix task ${t.id} created.`);
  return t;
}

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
    if (M === 'POST' && a === 'runtimes' && b === 'switch') { const x = await body(req); return send(res, 200, switchRuntime(x.from, x.to, x.agents)); }
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
        mutateChatIndex(b, (ix) => { const ch = ix.chats.find((y) => y.id === (x.chatId || ix.current)); if (ch) ch.runtime = x.runtime; });
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
    if (M === 'POST' && a === 'issues' && b && c === 'run') { const t = fixTaskFor(b); return send(res, 200, { task: t.id, ...runTask(t.id) }); }
    if (M === 'POST' && a === 'issues' && b && c === 'stop') {
      const i = getIssues().find((x) => x.id === b);
      if (!i?.fix_task) fail(`${b} has no running fix task`);
      return send(res, 200, stopTask(i.fix_task));
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
