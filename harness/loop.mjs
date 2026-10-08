#!/usr/bin/env node
// The work loop: pick ready tasks -> dispatch to a free agent of the right role ->
// verify (quality gate + reviewer agent) -> done, or retry with feedback, or pending.
//
//   node harness/loop.mjs                 run the whole board until finished
//   node harness/loop.mjs --once          dispatch one round and wait for it
//   node harness/loop.mjs --task T-007    run only this task until done/pending/stopped
//   node harness/loop.mjs --task T-007,T-008   run these tasks in order (stops at the first not done)
//
// Usage limits: when an agent's runtime (Claude Code, Codex, ...) hits its plan limit, the task
// goes back to todo without using an attempt. Then, per Settings → "When a runtime hits its limit":
//   wait   (default) agents on that runtime pause; the loop keeps waiting, re-checks the runtime
//          (at the reset time, or every limits.probe_minutes) and continues when it is back
//   switch agents move to another runtime and move back when the limit resets
//   stop   the loop stops
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, P, ensureState, loadConfig, loadRole, getTasks, updateTask, addIssue, updateIssue, getIssues,
  getAgents, setAgent, writeJson, readJson, mutate, logActivity, unavailableRuntimes, runtimeOf, pidAlive, now,
  readDoc, bugReportPath, syncSkills, getLimits, getHealth, limitPolicy, setAgentsRuntime, boardBlockers,
} from './lib/store.mjs';
import { runAgent, stopAll, killTree, checkRuntime, maybeProbeLimits, restoreHomeRuntimes, fallbackRuntime } from './lib/runner.mjs';

ensureState();
const argTasks = (() => { const i = process.argv.indexOf('--task'); return i > 0 ? String(process.argv[i + 1]).split(',').filter(Boolean) : []; })();
const argTask0 = argTasks[0] || null;
let argTask = argTask0; // the task a single run is working on right now
const ONCE = process.argv.includes('--once');
const SINGLE = !!argTask0;
const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3 };
const running = new Map(); // taskId -> { agents:[], promise }
let iterations = 0;
let stopping = false;
let gateChild = null;

const cfg = () => loadConfig();
const L = () => ({
  max_parallel: 1, max_iterations: 50, max_attempts: 3, poll_ms: 3000,
  review: true, gate_command: 'bash scripts/agent/run_quality_gate.sh', gate_timeout_s: 1800,
  use_worktrees: false, ...(cfg().loop || {}),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobFile = argTask0 ? path.join(P.jobs, `${argTask0}.json`) : null;
const setLoop = (patch) => {
  if (SINGLE) return writeJson(jobFile, { ...(fs.existsSync(jobFile) ? readJson(jobFile) : {}), ...patch, task: argTask0, tasks: argTasks, current: argTask, pid: process.pid, updated_at: now() });
  writeJson(P.loop, { ...readJson(P.loop), ...patch, updated_at: now(), pid: process.pid });
};
const runName = () => (SINGLE ? `run ${argTasks.join('→')}` : 'loop');
const log = (t) => { console.log(`[${runName()}] ${t}`); logActivity(runName(), t); };
const task = (id) => getTasks().find((x) => x.id === id);

function roleMeta(role) {
  try { return loadRole(role).meta; } catch { return {}; }
}

function recoverStale() {
  // Only clean up work whose owning process is gone (another loop or single run may be alive).
  for (const a of Object.values(getAgents())) {
    if (a.status === 'running' && !pidAlive(a.owner_pid)) setAgent(a.id, { status: 'idle', current_task: null, agent_pid: null });
  }
  for (const t of getTasks()) if (t.status === 'in-progress' && t.loop_owned && !pidAlive(t.owner_pid)) {
    updateTask(t.id, { status: 'todo', assignee: null, loop_owned: false, owner_pid: null }, 'loop', 'Recovered after the process running it exited; back to todo.');
  }
}

function readyTasks() {
  const tasks = getTasks();
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks
    .filter((t) => t.status === 'todo' && !running.has(t.id))
    .filter((t) => SINGLE ? t.id === argTask : (t.depends_on || []).every((d) => done.has(d)))
    .sort((a, b) => (PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9) || a.id.localeCompare(b.id));
}

function agentsFor(role) {
  return cfg().agents.filter((a) => a.role === role && a.enabled !== false);
}

function freeAgent(role, exclude = []) {
  const c = cfg();
  const st = getAgents();
  const limits = unavailableRuntimes();
  const busy = new Set([...running.values()].flatMap((r) => r.agents));
  return agentsFor(role).find((a) => !busy.has(a.id) && !exclude.includes(a.id)
    && !(st[a.id]?.status === 'running' && pidAlive(st[a.id]?.owner_pid))
    && !limits[runtimeOf(c, a)]);
}

const allLimited = (role) => {
  const c = cfg(); const limits = unavailableRuntimes();
  const list = agentsFor(role);
  return list.length > 0 && list.every((a) => limits[runtimeOf(c, a)]);
};

function taskPrompt(t) {
  const notes = (t.notes || []).slice(-8).map((n) => `- ${n.at} ${n.by}: ${n.text}`).join('\n');
  const issue = t.issue_ref ? getIssues().find((i) => i.id === t.issue_ref) : null;
  const report = issue ? readDoc(issue.repro?.file || bugReportPath(issue.id)) : null;
  const bugBlock = !issue ? '' : t.kind === 'repro'
    ? `\n## Bug to reproduce: ${issue.id}\nWrite the report to ${bugReportPath(issue.id)} (template docs/bugs/_template.md), add a skipped failing test, then "issue repro ${issue.id} --file ${bugReportPath(issue.id)} --test <path|none>". The quality gate is skipped for this task; the reviewer checks your report.\n`
    : report ? `\n## Repro report (${issue.repro?.file || bugReportPath(issue.id)})${issue.repro && !issue.repro.reproduced ? ' — NOT reproduced by the tester' : ''}\n${report}\n` : '';
  return `# Your task: ${t.id} — ${t.title}

Priority: ${t.priority}   Attempt: ${t.attempts}/${t.max_attempts || L().max_attempts}
${t.plan ? `Execution plan: ${t.plan}\n` : ''}${issue ? `Fixes issue ${issue.id} (${issue.type}, ${issue.severity}): ${issue.title}\n${issue.description || ''}\n` : ''}
## Description
${t.description || '(none — read the plan/spec, or block with a question if unclear)'}
${bugBlock}

## Acceptance criteria
${(t.acceptance || []).map((a) => `- [ ] ${a}`).join('\n') || '- (none listed — define them in a note before implementing)'}

## Recent notes
${notes || '(none)'}
${t.last_feedback ? `\n## Feedback from the previous attempt — fix this first\n${t.last_feedback}\n` : ''}
## Loop for this turn
1. Read what you need (AGENTS.md, plan, specs). Keep scope to this task.
2. Do the work in small steps; add a task note after each meaningful step.
3. Verify yourself (tests/gate) before submitting.
4. Finish with exactly one of: task submit ${t.id} --summary "..."  OR  task block ${t.id} --reason "..."`;
}

function reviewPrompt(t) {
  const sub = [...(t.notes || [])].reverse().find((n) => n.text.startsWith('SUBMITTED:'));
  return `# Review task ${t.id} — ${t.title}

The work was submitted by ${t.assignee}. Submission:
${sub ? sub.text : '(no summary)'}

Acceptance criteria:
${(t.acceptance || []).map((a) => `- ${a}`).join('\n') || '- (none listed)'}

Inspect the change (e.g. git status, git diff) against the acceptance criteria, AGENTS.md,
ARCHITECTURE.md and docs/agent-workflows/code-review-loop.md. Do not rewrite the code yourself.
Finish with exactly one of:
  node harness/cli.mjs task review ${t.id} --approve --note "<short reason>"
  node harness/cli.mjs task review ${t.id} --reject  --note "<concrete list of what to fix>"`;
}

function runGate(cwd) {
  const { gate_command, gate_timeout_s } = L();
  if (!gate_command) return Promise.resolve({ ok: true, output: 'gate disabled' });
  return new Promise((resolve) => {
    const child = spawn(gate_command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, HARNESS_ROOT: ROOT } });
    gateChild = child;
    let output = '';
    const keep = (d) => { output = (output + d.toString()).slice(-6000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { killTree(child.pid); output += '\n[gate] timed out'; }, gate_timeout_s * 1000);
    child.on('close', (code) => { clearTimeout(timer); gateChild = null; resolve({ ok: code === 0, output }); });
  });
}

function prepareWorkspace(t) {
  if (!L().use_worktrees) return ROOT;
  try { execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'ignore' }); } catch { return ROOT; }
  const dir = path.join(P.runs, '..', 'worktrees', t.id);
  const branch = `agent/${t.id}`;
  if (!fs.existsSync(dir)) {
    try { execSync(`git worktree add "${dir}" -b ${branch}`, { cwd: ROOT, stdio: 'ignore' }); }
    catch { execSync(`git worktree add "${dir}" ${branch}`, { cwd: ROOT, stdio: 'ignore' }); }
  }
  return dir;
}

// Claim a todo task atomically so two loops never take the same task.
function claim(id, agentId) {
  return mutate(P.tasks, (db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t || t.status !== 'todo') return null;
    Object.assign(t, {
      status: 'in-progress', assignee: agentId, attempts: (t.attempts || 0) + 1, submitted: false, review: null,
      loop_owned: true, owner_pid: process.pid, stop_requested: false, updated_at: now(),
    });
    t.notes.push({ at: now(), by: 'loop', text: `Dispatched to ${agentId}` });
    logActivity('loop', `${id}: todo → in-progress (${agentId})`, { ref: id });
    return { ...t };
  });
}

function stoppedByHuman(t) {
  updateTask(t.id, {
    status: 'pending', assignee: null, submitted: false, loop_owned: false, owner_pid: null, stop_requested: false,
    attempts: Math.max(0, (t.attempts || 1) - 1), pending_reason: 'Stopped by you — press Retry or Run to continue',
  }, 'human', 'Run stopped from the dashboard.');
  log(`${t.id} stopped by human`);
  return 'stopped';
}

function requeueForLimit(t, res, agentId) {
  const why = res.setup
    ? `${agentId} could not start ${res.runtime} (${res.setup.message}). Back to todo, attempt not counted. ${res.setup.hint || ''}`
    : `${agentId} (${res.runtime}) hit a usage limit; back to todo, attempt not counted. ${res.limit?.resets_at ? `Limit resets ${res.limit.resets_at}.` : ''}`;
  updateTask(t.id, {
    status: 'todo', assignee: null, submitted: false, loop_owned: false, owner_pid: null,
    attempts: Math.max(0, (t.attempts || 1) - 1),
  }, 'loop', why.trim());
  iterations = Math.max(0, iterations - 1);
  return 'limited';
}

function failAttempt(t, feedback, by = 'loop') {
  const fresh = task(t.id);
  const max = fresh.max_attempts || L().max_attempts;
  const base = { assignee: null, submitted: false, review: null, loop_owned: false, owner_pid: null };
  if (fresh.attempts >= max) {
    const issue = addIssue({ title: `${t.id} failed ${fresh.attempts} attempts`, description: feedback.slice(-3000), type: 'blocker', severity: 'high', task: t.id }, by);
    updateTask(t.id, { ...base, status: 'pending', last_feedback: feedback.slice(-4000), pending_reason: `Failed ${fresh.attempts}/${max} attempts (${issue.id}) — check the feedback, then Retry` }, by, `Moved to pending after ${fresh.attempts} attempts. See ${issue.id}.`);
    return 'pending';
  }
  updateTask(t.id, { ...base, status: 'todo', last_feedback: feedback.slice(-4000) }, by, `Retrying: ${feedback.slice(0, 300)}`);
  return 'retry';
}

async function work(t, agent) {
  const meta = roleMeta(t.role);
  const claimed = claim(t.id, agent.id);
  if (!claimed) return 'skipped';
  const cwd = prepareWorkspace(claimed);
  const res = await runAgent({ agentId: agent.id, taskId: t.id, prompt: taskPrompt(claimed), mode: 'task', cwd });
  let cur = task(t.id);

  if (cur.stop_requested || (SINGLE && stopping)) return stoppedByHuman(cur);
  if (res.limited || res.setup) return requeueForLimit(cur, res, agent.id);
  if (cur.status === 'pending') { log(`${t.id} blocked by ${agent.id}: ${cur.pending_reason}`); return 'pending'; }
  if (cur.status !== 'in-progress') { log(`${t.id} changed to ${cur.status} by someone else; leaving it.`); return cur.status; }
  if (!cur.submitted) return failAttempt(cur, `Agent ${agent.id} ended (exit ${res.code}) without "task submit" or "task block". Last output: ${(res.result || '').slice(-800)}`);

  if (meta.gate !== 'false' && claimed.kind !== 'repro') {
    log(`${t.id}: running quality gate`);
    const g = await runGate(cwd);
    cur = task(t.id);
    if (cur.stop_requested || (SINGLE && stopping)) return stoppedByHuman(cur);
    if (!g.ok) return failAttempt(cur, `Quality gate failed:\n${g.output.slice(-2500)}`);
    updateTask(t.id, {}, 'loop', 'Quality gate passed.');
  }

  if (L().review && meta.review !== 'false') {
    if (!agentsFor('reviewer').length) {
      updateTask(t.id, {}, 'loop', 'No reviewer agent enabled; skipping review.');
    } else {
      let reviewer = freeAgent('reviewer', [agent.id]);
      while (!reviewer) {
        cur = task(t.id);
        if (cur.stop_requested || stopping) return stoppedByHuman(cur);
        await sleep(L().poll_ms);
        reviewer = freeAgent('reviewer', [agent.id]);
      }
      const entry = running.get(t.id);
      if (entry) entry.agents.push(reviewer.id);
      const r = await runAgent({ agentId: reviewer.id, taskId: t.id, prompt: reviewPrompt(cur), mode: 'task', cwd });
      cur = task(t.id);
      if (cur.stop_requested || (SINGLE && stopping)) return stoppedByHuman(cur);
      if (r.limited || r.setup) {
        // Work is submitted and gate passed; keep it and wait for a reviewer later.
        updateTask(t.id, { status: 'todo', assignee: null, loop_owned: false, owner_pid: null, attempts: Math.max(0, cur.attempts - 1), last_feedback: null }, 'loop', `Reviewer ${reviewer.id} could not run (${r.setup ? 'runtime needs setup' : 'usage limit'}); task requeued for another try.`);
        return 'limited';
      }
      if (cur.review === 'rejected') {
        const fb = [...cur.notes].reverse().find((n) => n.text.startsWith('REVIEW REJECTED'));
        return failAttempt(cur, `Reviewer rejected: ${fb ? fb.text : ''}`);
      }
      if (cur.review !== 'approved') return failAttempt(cur, 'Reviewer gave no verdict.');
    }
  }
  return markDone(cur);
}

function markDone(t) {
  const branch = L().use_worktrees ? ` Branch agent/${t.id} is ready to merge.` : '';
  updateTask(t.id, { status: 'done', loop_owned: false, owner_pid: null, last_feedback: null, pending_reason: null }, 'loop', `Verified and done.${branch}`);
  if (t.issue_ref) {
    try {
      if (t.kind === 'repro') updateIssue(t.issue_ref, {}, 'loop', `Reproduction done in ${t.id}; the fix task can start.`);
      else updateIssue(t.issue_ref, { status: 'done' }, 'loop', `Fixed by ${t.id}.`);
    } catch {}
  }
  log(`${t.id} done`);
  return 'done';
}

function dispatch(t) {
  const agent = freeAgent(t.role);
  if (!agent) return false;
  iterations++;
  const entry = { agents: [agent.id] };
  entry.promise = work(t, agent)
    .catch((e) => { log(`${t.id} crashed: ${e.message}`); return failAttempt(t, `Loop error: ${e.message}`); })
    .then((r) => { entry.result = r; return r; })
    .finally(() => running.delete(t.id));
  running.set(t.id, entry);
  return entry;
}

// ---------- usage-limit policy ----------
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const noted = new Set();
const noteOnce = (key, text) => { if (!noted.has(key)) { noted.add(key); log(text); } };

// Limited runtimes that enabled agents actually use right now.
function limitedInUse() {
  const c = cfg();
  const lim = getLimits();
  return Object.keys(lim).filter((n) => c.agents.some((a) => a.enabled !== false && runtimeOf(c, a) === n));
}

function limitWaitText(names) {
  const lim = getLimits();
  const pol = limitPolicy();
  return names.map((n) => {
    const l = lim[n] || {};
    if (l.resets_at) return `${n} resets ${fmtTime(l.resets_at)}`;
    const next = new Date((Date.parse(l.last_check || l.at) || Date.now()) + pol.probe_minutes * 60000).toISOString();
    return `${n} — checking again ${fmtTime(next)}`;
  }).join('; ');
}

let lastHousekeeping = 0;
// Returns a stop reason when the policy says to stop, otherwise null.
async function applyLimitPolicy() {
  // Re-check limited runtimes and move auto-switched agents back (throttled, cheap).
  if (Date.now() - lastHousekeeping > 30000) {
    lastHousekeeping = Date.now();
    maybeProbeLimits().catch(() => {});
    try { restoreHomeRuntimes(); } catch {}
  }
  const names = limitedInUse();
  if (!names.length) return null;
  const pol = limitPolicy();
  if (pol.on_limit === 'stop') return `usage limit on ${names.join(', ')} — stopped (limit setting: stop)`;
  if (pol.on_limit === 'switch') {
    for (const name of names) {
      const c = cfg();
      const ids = c.agents.filter((a) => a.enabled !== false && runtimeOf(c, a) === name).map((a) => a.id);
      const to = fallbackRuntime(name);
      if (!to) { noteOnce(`nofb:${name}`, `${name} is limited and no other runtime is available — waiting instead`); continue; }
      const h = getHealth()[to];
      const fresh = h?.ok && h.checked && Date.now() - Date.parse(h.at) < 30 * 60000;
      if (!fresh) {
        setLoop({ status: 'running', reason: `${name} hit its limit — testing ${to} before switching` });
        const r = await checkRuntime(to);
        if (!r.ok) { noteOnce(`fbfail:${name}:${to}`, `${name} is limited and ${to} failed its check (${r.message || 'error'}) — waiting instead`); continue; }
      }
      setAgentsRuntime(ids, to, { auto: true, by: 'loop' });
      log(`${name} hit its usage limit — moved ${ids.join(', ')} to ${to} (limit setting: switch${pol.switch_back ? ', they move back when it resets' : ''})`);
    }
  }
  return null;
}

// Why nothing can start (for the stop reason / dashboard).
function blockedText(b) {
  if (!b.roots.length) return 'nothing to do';
  return b.roots.slice(0, 3).map((r) => {
    const n = r.waiting.length;
    const what = r.status === 'pending' ? `${r.id} (pending — answer it, then Retry)` : r.status === 'missing' ? `${r.title} (task does not exist)` : `${r.id} (${r.status})`;
    return `${n} task${n > 1 ? 's' : ''} wait on ${what}`;
  }).join('; ');
}
const busyElsewhere = () => getTasks().filter((t) => t.status === 'in-progress' && !running.has(t.id) && pidAlive(t.owner_pid)).map((t) => t.id);

async function runSingle() {
  for (const id of argTasks) {
    argTask = id;
    setLoop({ status: 'running', reason: null });
    const r = await runOne();
    if (r !== 'done' && r !== 'already done') return argTasks.length > 1 ? `${id}: ${r}` : r;
  }
  return argTasks.length > 1 ? `${argTasks.join(', ')} done` : 'done';
}

async function runOne() {
  const t0 = task(argTask);
  if (!t0) { log(`task ${argTask} not found`); return 'not found'; }
  const alive = Object.values(getAgents()).some((a) => a.current_task === argTask && a.status === 'running' && pidAlive(a.owner_pid));
  if (t0.status === 'done') return 'already done';
  if (t0.status === 'in-progress' && alive) return 'already running';
  // Explicit run: back to todo; pending/stale tasks get a fresh attempt budget.
  const reset = t0.status === 'pending' || t0.status === 'in-progress';
  updateTask(argTask, { status: 'todo', assignee: null, submitted: false, review: null, loop_owned: false, owner_pid: null, stop_requested: false, pending_reason: null, ...(reset ? { attempts: 0 } : {}) }, 'human', 'Run this task now (from the dashboard).');
  const unmet = (t0.depends_on || []).filter((d) => task(d)?.status !== 'done');
  if (unmet.length) updateTask(argTask, {}, 'loop', `Note: running even though ${unmet.join(', ')} is not done yet.`);

  for (;;) {
    if (stopping) return 'stopped by you';
    const t = task(argTask);
    if (t.status === 'done') return 'done';
    if (t.status === 'pending') return `pending: ${t.pending_reason || ''}`;
    if (t.status !== 'todo') { await sleep(L().poll_ms); continue; }
    if (!agentsFor(t.role).length) {
      updateTask(t.id, { status: 'pending', pending_reason: `No enabled agent with role "${t.role}"` }, 'loop', `No enabled agent with role "${t.role}".`);
      return 'no agent for role';
    }
    const stopWhy = await applyLimitPolicy();
    if (stopWhy && allLimited(t.role)) return stopWhy;
    if (allLimited(t.role)) {
      const names = limitedInUse();
      setLoop({ status: 'waiting', reason: names.length ? `waiting for usage limit: ${limitWaitText(names)}` : `every ${t.role} agent is on a runtime that needs setup` });
      await sleep(L().poll_ms);
      continue;
    }
    const e = dispatch(t);
    if (!e) { setLoop({ status: 'waiting', reason: `waiting for a free ${t.role} agent` }); await sleep(L().poll_ms); continue; }
    setLoop({ status: 'running', reason: null, agent: e.agents[0] });
    await e.promise;
  }
}

const startedAt = Date.now();
let timeUp = false;
let stopReason = null;
async function runBoard() {
  for (;;) {
    if (fs.existsSync(P.stop)) stopping = true;
    if (stopping) return stopReason || (timeUp ? `time limit (${L().max_run_minutes} min) reached` : 'stopped by operator');
    const maxMin = Number(L().max_run_minutes || 0);
    if (maxMin > 0 && !timeUp && Date.now() - startedAt > maxMin * 60000) {
      timeUp = true; stopping = true;
      log(`time limit of ${maxMin} min reached — no new dispatches; running turns will finish`);
      continue;
    }
    const { max_parallel, max_iterations } = L();
    const waitingOnLimit = new Set();
    const stopWhy = await applyLimitPolicy();
    if (stopWhy) { stopping = true; stopReason = stopWhy; log(stopWhy); continue; }

    for (const t of readyTasks()) {
      if (running.size >= max_parallel || iterations >= max_iterations) break;
      if (!agentsFor(t.role).length) {
        updateTask(t.id, { status: 'pending', pending_reason: `No enabled agent with role "${t.role}" — enable one in Settings, then Retry` }, 'loop', `No agent with role "${t.role}".`);
        continue;
      }
      if (allLimited(t.role)) { waitingOnLimit.add(t.role); continue; }
      dispatch(t);
    }
    const limitedNames = limitedInUse();
    setLoop({
      status: 'running', iterations, active: [...running.keys()],
      reason: waitingOnLimit.size && !running.size
        ? (limitedNames.length ? `waiting for usage limit: ${limitWaitText(limitedNames)}` : `waiting: ${[...waitingOnLimit].join(', ')} agents are on a runtime that needs setup`)
        : null,
    });

    if (running.size === 0) {
      const open = getTasks().filter((t) => t.status !== 'done');
      if (ONCE && iterations > 0) return 'single round finished';
      if (open.length === 0) return 'all tasks done';
      if (readyTasks().length === 0) {
        // Tasks being worked on by a single run (or another process) may unblock the rest: wait for them.
        const elsewhere = busyElsewhere();
        if (elsewhere.length) {
          setLoop({ status: 'running', reason: `waiting for ${elsewhere.join(', ')} to finish (started outside the loop)` });
          await sleep(L().poll_ms);
          continue;
        }
        const b = boardBlockers();
        if (b.todo === 0) {
          const pend = open.filter((t) => t.status === 'pending').map((t) => t.id);
          return pend.length ? `waiting for you on ${pend.join(', ')}` : 'nothing left to start';
        }
        return `nothing can start: ${blockedText(b)}`;
      }
      if (iterations >= max_iterations) return `max_iterations (${max_iterations}) reached`;
    }
    await sleep(L().poll_ms);
  }
}

async function main() {
  recoverStale();
  try { syncSkills(); } catch {}
  if (!SINGLE && fs.existsSync(P.stop)) fs.rmSync(P.stop);
  setLoop({ status: 'running', started_at: now(), reason: null, finished_at: null });
  log(SINGLE ? 'started' : `started (parallel=${L().max_parallel}, max_iterations=${L().max_iterations})`);

  let signals = 0;
  const onSig = () => {
    signals++;
    stopping = true;
    setLoop({ status: 'stopping' });
    // A single run stops right away; the board loop lets current turns finish
    // unless it is signalled twice.
    if (SINGLE || signals > 1) {
      if (SINGLE) try { mutate(P.tasks, (db) => { const t = db.tasks.find((x) => x.id === argTask); if (t && t.status === 'in-progress') t.stop_requested = true; }); } catch {}
      stopAll();
      if (gateChild) killTree(gateChild.pid);
    }
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const reason = SINGLE ? await runSingle() : await runBoard();
  await Promise.allSettled([...running.values()].map((r) => r.promise));
  setLoop({ status: 'stopped', reason, finished_at: now(), active: [] });
  log(`stopped: ${reason}`);
  if (!SINGLE && fs.existsSync(P.stop)) fs.rmSync(P.stop);
}

main();
