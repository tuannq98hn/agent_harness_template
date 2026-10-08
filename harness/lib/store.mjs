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
  health: path.join(STATE_DIR, 'runtime-health.json'),
  serverLog: path.join(STATE_DIR, 'dashboard.log'),
  jobs: path.join(STATE_DIR, 'jobs'),
  asks: path.join(STATE_DIR, 'asks'),
  stop: path.join(STATE_DIR, 'STOP'),
  lock: path.join(STATE_DIR, '.lock'),
  config: path.join(ROOT, 'harness.config.json'),
  agentDefs: path.join(ROOT, 'agents'),
  skills: path.join(ROOT, '.agents', 'skills'),          // canonical (Codex reads this natively)
  claudeSkills: path.join(ROOT, '.claude', 'skills'),    // mirror for Claude Code
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
  if (!fs.existsSync(P.health)) writeJson(P.health, { runtimes: {} });
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

// Directory lock: mkdir is atomic on every OS. The owner's pid is stored inside, so a lock
// left by a killed process is broken at once; any lock older than 5s is treated as stale.
function lockOwnerGone() {
  try {
    const pid = Number(fs.readFileSync(path.join(P.lock, 'pid'), 'utf8'));
    if (pid && !pidAlive(pid)) return true;
  } catch {}
  try { return Date.now() - fs.statSync(P.lock).mtimeMs > 5000; } catch { return false; }
}
export function withLock(fn) {
  const deadline = Date.now() + 6000;
  for (;;) {
    try {
      fs.mkdirSync(P.lock);
      try { fs.writeFileSync(path.join(P.lock, 'pid'), String(process.pid)); } catch {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockOwnerGone()) { try { fs.rmSync(P.lock, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() > deadline) throw new Error('Could not acquire .harness lock');
      sleepSync(20);
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
      kind: input.kind || null,          // 'repro' | 'fix' | null
      issue_ref: input.issue_ref || null, // issue this task reproduces or fixes
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
  let isNew = false;
  mutate(P.limits, (db) => {
    const prev = db.runtimes[runtime];
    isNew = !prev;
    // Keep the original "at" so the dashboard asks only once; refresh message/reset time.
    db.runtimes[runtime] = { ...(prev || {}), ...info, resets_at: info.resets_at || prev?.resets_at || null, at: prev?.at || now(), seen_at: now() };
  });
  if (isNew) logActivity('harness', `${runtime} hit a usage limit${info.agent ? ` (seen by ${info.agent})` : ''}: ${String(info.message || '').slice(0, 140)}${info.resets_at ? ` — resets ${info.resets_at}` : ''}`);
}
export function clearLimit(runtime, by = 'human') {
  mutate(P.limits, (db) => { delete db.runtimes[runtime]; });
  logActivity(by, by === 'human' ? `marked ${runtime} as available again` : `${runtime} is available again (check passed)`);
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

// ---------- Runtime health: "this CLI cannot run here yet" (not trusted, not logged in, missing) ----------
export function getHealth() {
  return fs.existsSync(P.health) ? readJson(P.health).runtimes : {};
}
export function setHealth(runtime, info) {
  const prev = getHealth()[runtime];
  mutate(P.health, (db) => { db.runtimes[runtime] = { ...info, at: now() }; });
  if (info.ok === false && (!prev || prev.ok !== false || prev.message !== info.message)) {
    logActivity('harness', `${runtime} cannot run in this project: ${String(info.message || '').slice(0, 160)}`);
  }
  if (info.ok && prev && prev.ok === false) logActivity('harness', `${runtime} works again`);
}
export function clearHealth(runtime) {
  mutate(P.health, (db) => { delete db.runtimes[runtime]; });
}
// A runtime is unusable when it hit a usage limit or failed its setup check.
export function unavailableRuntimes() {
  const out = {};
  for (const [k, v] of Object.entries(getLimits())) out[k] = { kind: 'limit', ...v };
  for (const [k, v] of Object.entries(getHealth())) if (v.ok === false && !out[k]) out[k] = { kind: 'setup', ...v };
  return out;
}

// ---------- Bug flow: Reproduce (tester) -> Fix (implementer) ----------
const SEV_PRIO = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
export const bugReportPath = (issueId) => `docs/bugs/${issueId}.md`;

export function createBugTasks(issueId, { repro = true } = {}, by = 'human') {
  const i = getIssues().find((x) => x.id === issueId);
  if (!i) throw new Error(`Issue ${issueId} not found`);
  if (i.status === 'done') throw new Error(`${issueId} is already done`);
  if (i.type === 'blocker' && i.task) throw new Error(`${i.id} is a question on ${i.task}. Answer it on the task, then Retry ${i.task}.`);
  const tasks = getTasks();
  const open = (id) => { const t = id && tasks.find((x) => x.id === id); return t && t.status !== 'done' ? t : null; };
  const existingFix = open(i.fix_task);
  if (existingFix) return { fix: existingFix, repro: open(i.repro_task) };

  const prio = SEV_PRIO[i.severity] || 'P2';
  const report = bugReportPath(i.id);
  const needRepro = repro && i.type === 'bug' && !i.repro?.reproduced;
  let r = null;
  if (needRepro) {
    r = addTask({
      title: `Reproduce ${i.id}: ${i.title}`, role: 'tester', priority: prio, kind: 'repro', issue_ref: i.id,
      description: `Reproduce issue ${i.id} and document it so another agent can fix it without guessing.\n\n` +
        `Reported: ${i.description || '(no details — ask in a block if you need more)'}\n${i.task ? `Related task: ${i.task}\n` : ''}` +
        `Follow agents/tester.md section A and docs/agent-workflows/bug-reproduction.md.`,
      acceptance: [
        `${report} written from docs/bugs/_template.md: environment, numbered steps, expected vs actual, evidence, frequency`,
        `A failing test for the bug exists and is skipped with "${i.id}" (or the report explains why no test is possible)`,
        `Registered with: node harness/cli.mjs issue repro ${i.id} --file ${report} --test <path|none>`,
        'No production code changed',
      ],
    }, by);
  }
  const f = addTask({
    title: `Fix ${i.id}: ${i.title}`, role: 'implementer', priority: prio, kind: 'fix', issue_ref: i.id,
    depends_on: r ? [r.id] : [],
    description: `${i.description || ''}\n\n${r || i.repro ? `Start from the repro report ${report}.` : 'No repro report: reproduce it yourself first and note how.'}\nFollow agents/implementer.md "Bug fixes".`.trim(),
    acceptance: r || i.repro
      ? [`${i.id} no longer reproduces with the steps in ${report}`, 'Repro test un-skipped and passing', `Root cause, change and commit written in the Fix section of ${report}`]
      : [`${i.id} no longer reproduces (steps written in a task note)`, 'Regression test added where practical', 'Root cause written in a task note'],
  }, by);
  updateIssue(i.id, { fix_task: f.id, repro_task: r?.id || i.repro_task || null, status: 'in-progress' }, by,
    r ? `Created ${r.id} (reproduce, tester) → ${f.id} (fix, implementer).` : `Created fix task ${f.id}.`);
  return { fix: f, repro: r };
}

export function registerRepro(issueId, { file, test, reproduced = true }, by) {
  const i = getIssues().find((x) => x.id === issueId);
  if (!i) throw new Error(`Issue ${issueId} not found`);
  if (!file) throw new Error('issue repro needs --file docs/bugs/<ISSUE>.md');
  if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`Report not found: ${file}`);
  return updateIssue(issueId, { repro: { file, test: test || null, reproduced, by, at: now() } }, by,
    reproduced ? `Reproduced. Report: ${file}${test ? `, test: ${test}` : ''}` : `NOT reproduced. Attempts documented in ${file}`);
}

// Read a markdown doc inside the repo's docs/ folder (for prompts and the dashboard).
export function readDoc(rel, max = 8000) {
  if (!rel) return null;
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(path.join(ROOT, 'docs') + path.sep) || !fs.existsSync(full)) return null;
  const t = fs.readFileSync(full, 'utf8');
  return t.length > max ? `${t.slice(0, max)}\n…(truncated, read the file for the rest)` : t;
}

// ---------- Skills (Agent Skills standard: <dir>/<name>/SKILL.md with name + description) ----------
export function listSkills() {
  if (!fs.existsSync(P.skills)) return [];
  return fs.readdirSync(P.skills, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(P.skills, d.name, 'SKILL.md')))
    .map((d) => {
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(P.skills, d.name, 'SKILL.md'), 'utf8'));
      return { name: meta.name || d.name, dir: d.name, description: meta.description || '', path: `.agents/skills/${d.name}/SKILL.md` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const roleSkills = (meta) => String(meta?.skills || '').split(',').map((x) => x.trim()).filter(Boolean);

// Mirror .agents/skills into .claude/skills so Claude Code loads them natively.
// Only folders this function created (marked with .harness-synced) are updated or removed;
// skills you put in .claude/skills yourself are never touched.
const MARK = '.harness-synced';
export function syncSkills() {
  const skills = listSkills();
  if (!skills.length) return { synced: 0, removed: 0 };
  fs.mkdirSync(P.claudeSkills, { recursive: true });
  let synced = 0;
  let removed = 0;
  const names = new Set(skills.map((s) => s.dir));
  for (const s of skills) {
    const dst = path.join(P.claudeSkills, s.dir);
    if (fs.existsSync(dst) && !fs.existsSync(path.join(dst, MARK))) continue; // user's own skill wins
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(P.skills, s.dir), dst, { recursive: true });
    fs.writeFileSync(path.join(dst, MARK), 'Copied from .agents/skills by the harness. Edit the original there.\n');
    synced++;
  }
  for (const d of fs.readdirSync(P.claudeSkills, { withFileTypes: true })) {
    if (d.isDirectory() && !names.has(d.name) && fs.existsSync(path.join(P.claudeSkills, d.name, MARK))) {
      fs.rmSync(path.join(P.claudeSkills, d.name), { recursive: true, force: true });
      removed++;
    }
  }
  return { synced, removed };
}

// ---------- Usage-limit policy ----------
// wait   (default) pause agents on the limited runtime; resume automatically when it is available again
// switch move them to another runtime; move them back when the limit resets (switch_back)
// stop   stop the loop when a limit is hit
export function limitPolicy(cfg = loadConfig()) {
  const l = cfg.limits || {};
  return {
    on_limit: ['wait', 'switch', 'stop'].includes(l.on_limit) ? l.on_limit : 'wait',
    fallback: l.fallback || 'auto',
    switch_back: l.switch_back !== false,
    probe_minutes: Math.max(5, Number(l.probe_minutes) || 15),
  };
}

// Reset time from a CLI limit message. Handles:
//  "…limit reached|1759830000"            (epoch, older Claude Code)
//  "resets 3pm" / "resets at 3:30 PM" / "reset at 15:00" / "resets 2am (Asia/Saigon)"
//  "try again in 2 hours 15 minutes" / "in 1h 23m" / "resets in 45 min" / "in 3 days"
//  ISO timestamps
export function parseReset(text, from = new Date()) {
  if (!text) return null;
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = text.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)/);
  if (iso && !Number.isNaN(Date.parse(iso[1]))) return new Date(iso[1]).toISOString();
  const rel = text.match(/(?:try again|resets?|available)\s+in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b[\s,and]*)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*(d|h|m|s)/gi)) ms += Number(n) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[u.toLowerCase()];
    if (ms > 0) return new Date(from.getTime() + ms).toISOString();
  }
  const at = text.match(/resets?\s+(?:at\s+|on\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (at && (at[3] || at[2])) {
    let h = Number(at[1]) % 24;
    const m = Number(at[2] || 0);
    if (at[3]) { h = h % 12; if (/pm/i.test(at[3])) h += 12; }
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d <= from) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return null;
}

// Move agents to another runtime. Models are remembered per runtime, so switching
// Claude → Codex → Claude gives each agent its Claude model back.
// auto=true (limit policy) remembers the agent's home runtime so it can be moved back.
export function setAgentsRuntime(ids, to, { auto = false, by = 'human' } = {}) {
  const changed = mutateConfig((c) => {
    if (!c.runtimes[to]) throw new Error(`Unknown runtime "${to}"`);
    const out = [];
    for (const a of c.agents) {
      if (!ids.includes(a.id)) continue;
      const from = runtimeOf(c, a);
      if (from === to) { if (!auto) delete a.home_runtime; continue; }
      a.model_by_runtime = a.model_by_runtime || {};
      if (a.model) a.model_by_runtime[from] = a.model; else delete a.model_by_runtime[from];
      if (a.model_by_runtime[to]) a.model = a.model_by_runtime[to]; else delete a.model;
      if (!Object.keys(a.model_by_runtime).length) delete a.model_by_runtime;
      a.runtime = to;
      if (auto) a.home_runtime = a.home_runtime || from; else delete a.home_runtime;
      out.push(a.id);
    }
    return out;
  });
  for (const a of Object.values(getAgents())) {
    if (changed.includes(a.id) && (a.status === 'limited' || a.status === 'error')) setAgent(a.id, { status: 'idle', last_message: '' });
  }
  if (changed.length) logActivity(by, `${auto ? 'auto-' : ''}switched ${changed.join(', ')} to ${to}`);
  return changed;
}

// Why can't todo tasks start? Finds the "root" tasks every blocked task is waiting on.
export function boardBlockers() {
  const tasks = getTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unmet = (t) => (t.depends_on || []).filter((d) => byId.get(d)?.status !== 'done');
  const memo = new Map();
  const roots = (t, seen = new Set()) => {
    if (memo.has(t.id)) return memo.get(t.id);
    const out = new Set();
    for (const d of unmet(t)) {
      const dt = byId.get(d);
      if (!dt) { out.add(`missing:${d}`); continue; }
      if (seen.has(d)) continue;
      if (dt.status === 'todo' && unmet(dt).length) for (const r of roots(dt, new Set([...seen, t.id]))) out.add(r);
      else out.add(d);
    }
    memo.set(t.id, out);
    return out;
  };
  const todo = tasks.filter((t) => t.status === 'todo');
  const ready = todo.filter((t) => !unmet(t).length).map((t) => t.id);
  const blockedBy = {};
  for (const t of todo) {
    if (!unmet(t).length) continue;
    for (const r of roots(t)) (blockedBy[r] = blockedBy[r] || []).push(t.id);
  }
  const rootList = Object.entries(blockedBy).map(([id, waiting]) => {
    const t = byId.get(id);
    return { id, status: t?.status || 'missing', title: t?.title || id.replace(/^missing:/, ''), reason: t?.pending_reason || null, waiting };
  }).sort((a, b) => b.waiting.length - a.waiting.length);
  return { ready, todo: todo.length, roots: rootList, in_progress: tasks.filter((t) => t.status === 'in-progress').map((t) => t.id) };
}
