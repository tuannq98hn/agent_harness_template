// Shared state store for the harness.
// All board state lives in .harness/ as JSON so agents (via CLI), the loop and the
// dashboard read/write the same source of truth. Writes are serialized with a
// directory lock and written atomically (tmp file + rename).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.HARNESS_ROOT || path.resolve(HERE, '..', '..');
export const STATE_DIR = path.join(ROOT, '.harness');
export const P = {
  tasks: path.join(STATE_DIR, 'tasks.json'),
  issues: path.join(STATE_DIR, 'issues.json'),
  agents: path.join(STATE_DIR, 'agents.json'),
  loop: path.join(STATE_DIR, 'loop.json'),
  activity: path.join(STATE_DIR, 'activity.jsonl'),
  runs: path.join(STATE_DIR, 'runs'),
  chat: path.join(STATE_DIR, 'chat'),
  limits: path.join(STATE_DIR, 'limits.json'),
  jobs: path.join(STATE_DIR, 'jobs'),
  asks: path.join(STATE_DIR, 'asks'),
  stop: path.join(STATE_DIR, 'STOP'),
  lock: path.join(STATE_DIR, '.lock'),
  config: path.join(ROOT, 'harness.config.json'),
  agentDefs: path.join(ROOT, 'agents'),
};

export const STATUSES = ['todo', 'in-progress', 'done', 'pending'];
export const now = () => new Date().toISOString();

export function loadConfig() {
  return JSON.parse(fs.readFileSync(P.config, 'utf8'));
}

// Read-modify-write harness.config.json (used by the dashboard settings).
export function mutateConfig(fn) {
  return withLock(() => {
    const cfg = loadConfig();
    const result = fn(cfg);
    writeJson(P.config, cfg);
    return result;
  });
}

export const runtimeOf = (cfg, agent) => agent.runtime || cfg.default_runtime;

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function ensureState() {
  for (const d of [STATE_DIR, P.runs, P.chat, P.jobs, P.asks]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(P.limits)) writeJson(P.limits, { runtimes: {} });
  if (!fs.existsSync(P.tasks)) writeJson(P.tasks, { seq: 0, tasks: [] });
  if (!fs.existsSync(P.issues)) writeJson(P.issues, { seq: 0, issues: [] });
  if (!fs.existsSync(P.agents)) writeJson(P.agents, { agents: {} });
  if (!fs.existsSync(P.loop)) writeJson(P.loop, { status: 'stopped' });
  // Make sure every configured agent instance has a runtime entry.
  const cfg = loadConfig();
  const st = readJson(P.agents);
  let changed = false;
  for (const a of cfg.agents) {
    if (!st.agents[a.id]) {
      st.agents[a.id] = { id: a.id, role: a.role, status: 'idle', current_task: null, last_activity: null, last_message: '' };
      changed = true;
    }
  }
  if (changed) writeJson(P.agents, st);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Directory lock: mkdir is atomic on every OS. Stale locks (>10s) are broken.
export function withLock(fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.mkdirSync(P.lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(P.lock).mtimeMs;
        if (age > 10000) fs.rmSync(P.lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error('Could not acquire .harness lock');
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(P.lock, { recursive: true, force: true });
  }
}

// Read-modify-write a JSON file under lock.
export function mutate(file, fn) {
  return withLock(() => {
    const data = readJson(file);
    const result = fn(data);
    writeJson(file, data);
    return result;
  });
}

export function logActivity(by, text, extra = {}) {
  fs.appendFileSync(P.activity, JSON.stringify({ at: now(), by, text, ...extra }) + '\n');
}

export function readActivity(limit = 200) {
  if (!fs.existsSync(P.activity)) return [];
  const lines = fs.readFileSync(P.activity, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------- Tasks ----------
export function addTask(input, by = 'human') {
  return mutate(P.tasks, (db) => {
    db.seq += 1;
    const t = {
      id: `T-${String(db.seq).padStart(3, '0')}`,
      title: input.title,
      description: input.description || '',
      status: input.status || 'todo',
      role: input.role || 'implementer',
      priority: input.priority || 'P2',
      assignee: null,
      depends_on: input.depends_on || [],
      acceptance: input.acceptance || [],
      plan: input.plan || null,
      issues: [],
      attempts: 0,
      max_attempts: input.max_attempts || null,
      submitted: false,
      pending_reason: null,
      notes: [],
      created_by: by,
      created_at: now(),
      updated_at: now(),
    };
    db.tasks.push(t);
    logActivity(by, `created task ${t.id}: ${t.title}`, { ref: t.id });
    return t;
  });
}

export function updateTask(id, patch, by = 'human', note) {
  return mutate(P.tasks, (db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Task ${id} not found`);
    if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`Invalid status ${patch.status}`);
    const before = t.status;
    Object.assign(t, patch, { updated_at: now() });
    if (note) t.notes.push({ at: now(), by, text: note });
    if (patch.status && patch.status !== before) logActivity(by, `${id}: ${before} → ${patch.status}${note ? ` (${note.slice(0, 120)})` : ''}`, { ref: id });
    else if (note) logActivity(by, `${id}: ${note.slice(0, 160)}`, { ref: id });
    return t;
  });
}

export function getTasks() { return readJson(P.tasks).tasks; }

// ---------- Issues ----------
export function addIssue(input, by = 'human') {
  const issue = mutate(P.issues, (db) => {
    db.seq += 1;
    const i = {
      id: `I-${String(db.seq).padStart(3, '0')}`,
      title: input.title,
      description: input.description || '',
      type: input.type || 'bug',
      severity: input.severity || 'medium',
      status: input.status || 'todo',
      task: input.task || null,
      assignee: input.assignee || null,
      notes: [],
      created_by: by,
      created_at: now(),
      updated_at: now(),
    };
    db.issues.push(i);
    logActivity(by, `opened issue ${i.id}: ${i.title}`, { ref: i.id });
    return i;
  });
  if (issue.task) {
    try {
      mutate(P.tasks, (db) => {
        const t = db.tasks.find((x) => x.id === issue.task);
        if (t && !t.issues.includes(issue.id)) t.issues.push(issue.id);
      });
    } catch {}
  }
  return issue;
}

export function updateIssue(id, patch, by = 'human', note) {
  return mutate(P.issues, (db) => {
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw new Error(`Issue ${id} not found`);
    if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`Invalid status ${patch.status}`);
    const before = i.status;
    Object.assign(i, patch, { updated_at: now() });
    if (note) i.notes.push({ at: now(), by, text: note });
    if (patch.status && patch.status !== before) logActivity(by, `${id}: ${before} → ${patch.status}${note ? ` (${note.slice(0, 120)})` : ''}`, { ref: id });
    else if (note) logActivity(by, `${id}: ${note.slice(0, 160)}`, { ref: id });
    return i;
  });
}

export function getIssues() { return readJson(P.issues).issues; }

// ---------- Agents runtime ----------
export function setAgent(id, patch) {
  return mutate(P.agents, (db) => {
    db.agents[id] = { ...(db.agents[id] || { id }), ...patch, last_activity: now() };
    return db.agents[id];
  });
}
export function getAgents() { return readJson(P.agents).agents; }

// ---------- Agent definitions (agents/*.md with frontmatter) ----------
export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

export function loadRole(role) {
  const file = path.join(P.agentDefs, `${role}.md`);
  if (!fs.existsSync(file)) throw new Error(`No agent definition: agents/${role}.md`);
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return { role, meta, body, file };
}

export function listRoles() {
  return fs.readdirSync(P.agentDefs).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''));
}

// ---------- Usage limits (per runtime: a Claude limit affects every Claude agent) ----------
export function getLimits() {
  const db = fs.existsSync(P.limits) ? readJson(P.limits) : { runtimes: {} };
  // Drop limits whose reset time has passed.
  const t = Date.now();
  let expired = false;
  for (const [k, v] of Object.entries(db.runtimes)) {
    if (v.resets_at && new Date(v.resets_at).getTime() < t) { delete db.runtimes[k]; expired = true; }
  }
  if (expired) { try { mutate(P.limits, (d) => { for (const k of Object.keys(d.runtimes)) if (!db.runtimes[k]) delete d.runtimes[k]; }); } catch {} }
  return db.runtimes;
}
export function setLimit(runtime, info) {
  mutate(P.limits, (db) => { db.runtimes[runtime] = { ...info, at: now() }; });
  logActivity('harness', `${runtime} hit a usage limit${info.agent ? ` (seen by ${info.agent})` : ''}: ${String(info.message || '').slice(0, 140)}`);
}
export function clearLimit(runtime, by = 'human') {
  mutate(P.limits, (db) => { delete db.runtimes[runtime]; });
  logActivity(by, `marked ${runtime} as available again`);
}
export const isLimited = (runtime) => !!getLimits()[runtime];

// ---------- Chat sessions: .harness/chat/<agent>/index.json + <chatId>.jsonl ----------
const chatDir = (agent) => path.join(P.chat, agent);
const chatIndexFile = (agent) => path.join(chatDir(agent), 'index.json');
export const chatFile = (agent, id) => path.join(chatDir(agent), `${id}.jsonl`);

export function chatIndex(agent) {
  fs.mkdirSync(chatDir(agent), { recursive: true });
  if (!fs.existsSync(chatIndexFile(agent))) writeJson(chatIndexFile(agent), { current: null, chats: [] });
  return readJson(chatIndexFile(agent));
}
export function mutateChatIndex(agent, fn) {
  chatIndex(agent);
  return mutate(chatIndexFile(agent), fn);
}
export function newChat(agent, runtime) {
  return mutateChatIndex(agent, (ix) => {
    const id = `c${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${Math.random().toString(36).slice(2, 6)}`;
    const c = { id, title: 'New chat', runtime: runtime || null, runtime_session: null, created_at: now(), updated_at: now(), count: 0 };
    ix.chats.unshift(c);
    ix.current = id;
    return c;
  });
}
export function currentChat(agent) {
  const ix = chatIndex(agent);
  return ix.chats.find((c) => c.id === ix.current) || null;
}
export function chatMessages(agent, id, limit = 300) {
  const f = chatFile(agent, id);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit);
}
export function appendChat(agent, id, msg) {
  const m = { at: now(), ...msg };
  fs.appendFileSync(chatFile(agent, id), JSON.stringify(m) + '\n');
  mutateChatIndex(agent, (ix) => {
    const c = ix.chats.find((x) => x.id === id);
    if (!c) return;
    c.updated_at = m.at;
    c.count = (c.count || 0) + 1;
    if (c.title === 'New chat' && msg.from === 'human') c.title = msg.text.replace(/\s+/g, ' ').slice(0, 60);
  });
  return m;
}

// Put a task back in the queue with a fresh attempt budget and close its blocker issues.
// Used by the Retry button and "task retry".
export function retryTask(id, by = 'human', note) {
  const before = getTasks().find((t) => t.id === id);
  if (!before) throw new Error(`Task ${id} not found`);
  if (before.status === 'done') throw new Error(`${id} is already done`);
  for (const i of getIssues()) if (i.task === id && i.type === 'blocker' && i.status !== 'done') {
    updateIssue(i.id, { status: 'done' }, by, `Closed by retry of ${id}${note ? `: ${note}` : ''}`);
  }
  return updateTask(id, {
    status: 'todo', attempts: 0, assignee: null, submitted: false, review: null, pending_reason: null,
    loop_owned: false, owner_pid: null, stop_requested: false,
  }, by, note ? `Retry: ${note}` : 'Retry requested.');
}
