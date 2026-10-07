// Agent-to-agent requests: one agent (any runtime) asks another agent (any runtime)
// to do something and gets the answer back in the same turn.
//
//   node harness/cli.mjs ask dev-1 "..."                 wait for the answer
//   node harness/cli.mjs ask dev-1 "..." --background    return an id at once
//   node harness/cli.mjs ask-result A-xxxx --wait 100     collect the answer later
//
// Runs go through the normal runner, so they show up on the dashboard, respect
// usage limits, and can be stopped like any other agent turn.
import fs from 'node:fs';
import path from 'node:path';
import {
  P, loadConfig, getAgents, getLimits, runtimeOf, pidAlive, readJson, writeJson, logActivity, updateTask, now,
} from './store.mjs';
import { runAgent, stopAgent } from './runner.mjs';

export const EXIT = { ok: 0, running: 1, failed: 2, limited: 3, refused: 4 };
const askFile = (id) => path.join(P.asks, `${id}.json`);
export const newAskId = () => `A-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function readAsk(id) {
  if (!fs.existsSync(askFile(id))) throw Object.assign(new Error(`No ask with id ${id}`), { exit: EXIT.refused });
  return readJson(askFile(id));
}
const saveAsk = (rec) => writeJson(askFile(rec.id), rec);

function refuse(msg) {
  throw Object.assign(new Error(msg), { exit: EXIT.refused });
}

// Agents that could take the request instead (same role, free, not limited).
function alternatives(cfg, inst) {
  const st = getAgents();
  const limits = getLimits();
  return cfg.agents
    .filter((a) => a.id !== inst.id && a.role === inst.role && a.enabled !== false)
    .filter((a) => !limits[runtimeOf(cfg, a)] && !(st[a.id]?.status === 'running' && pidAlive(st[a.id]?.owner_pid)))
    .map((a) => `${a.id} (${runtimeOf(cfg, a)})`);
}

// Checks done before anything runs, so the caller gets an immediate, useful error.
export function preflight(target) {
  const cfg = loadConfig();
  const caller = process.env.HARNESS_AGENT || 'human';
  const inst = cfg.agents.find((a) => a.id === target);
  if (!inst) refuse(`Unknown agent "${target}". Agents: ${cfg.agents.map((a) => a.id).join(', ')}`);
  if (inst.enabled === false) refuse(`${target} is disabled. Enable it in the dashboard or ask another agent.`);
  if (caller === target) refuse('An agent cannot ask itself.');
  const depth = Number(process.env.HARNESS_DEPTH || 0) + 1;
  const max = cfg.ask?.max_depth ?? 1;
  if (depth > max) refuse(`Nested asks are limited to depth ${max} (this would be ${depth}). Do it yourself or create a task with "task add".`);
  const runtime = runtimeOf(cfg, inst);
  const alt = () => { const a = alternatives(cfg, inst); return a.length ? ` Free agents with the same role: ${a.join(', ')}.` : ''; };
  const lim = getLimits()[runtime];
  if (lim) refuse(`${target} runs on ${runtime}, which hit its usage limit${lim.resets_at ? ` (resets ${lim.resets_at})` : ''}.${alt()}`);
  const st = getAgents()[target];
  if (st?.status === 'running' && pidAlive(st.owner_pid)) refuse(`${target} is busy${st.current_task ? ` on ${st.current_task}` : ''}.${alt()} Or create a task.`);
  return { cfg, inst, caller, depth, runtime };
}

function buildPrompt(caller, request, { readonly, taskId }) {
  return `## Mode: direct request from ${caller} (agent-to-agent)
${caller} sent you the request below and is waiting for your answer.
- Do exactly what is asked; keep the scope tight.
- Your final message is returned to ${caller} as-is. Make it short and complete:
  what you found or changed, file paths, and how you verified it.
- This is not a loop turn: do not use "task submit", "task block" or "task review".
${taskId ? `- Context: this belongs to task ${taskId} (node harness/cli.mjs task show ${taskId}). You may add notes to it.\n` : ''}${readonly ? '- READ-ONLY: do not create, edit or delete files and do not run commands that change state.\n' : ''}- If the request is unclear or too big, say so in one paragraph instead of guessing.

## Request
${request}`;
}

/** Run an ask to completion. Returns the saved record. */
export async function runAsk({ id, target, request, readonly = false, taskId = null, timeoutS }) {
  const { cfg, caller, depth, runtime } = preflight(target);
  const rec = {
    id: id || newAskId(), caller, target, runtime, request, readonly, task: taskId,
    status: 'running', reply: null, started_at: now(), finished_at: null, pid: process.pid,
  };
  saveAsk(rec);
  logActivity(caller, `asked ${target} (${runtime}): ${request.replace(/\s+/g, ' ').slice(0, 120)}`, { ref: rec.id });
  if (taskId) { try { updateTask(taskId, {}, caller, `Asked ${target} (${rec.id}): ${request.slice(0, 200)}`); } catch {} }

  const limit = Number(timeoutS || cfg.ask?.timeout_s || 540);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopAgent(target, 'task'); }, limit * 1000);
  const res = await runAgent({
    agentId: target, mode: 'ask', caller, depth, taskId,
    prompt: buildPrompt(caller, request, { readonly, taskId }),
    tools: readonly ? (cfg.ask?.readonly_tools || 'Read,Glob,Grep') : undefined,
  });
  clearTimeout(timer);

  rec.finished_at = now();
  rec.run_id = res.runId;
  if (res.limited) {
    rec.status = 'limited';
    const a = alternatives(cfg, cfg.agents.find((x) => x.id === target));
    rec.reply = `${target} (${runtime}) hit its usage limit: ${res.limit.message}.${a.length ? ` Try: ${a.join(', ')}.` : ''}`;
  } else if (timedOut) {
    rec.status = 'failed';
    rec.reply = `${target} did not answer within ${limit}s and was stopped. Ask for something smaller, or create a task.`;
  } else if (!res.ok) {
    rec.status = 'failed';
    rec.reply = `${target} failed (exit ${res.code}${res.signal ? `, ${res.signal}` : ''}): ${(res.result || '').slice(-600)}`;
  } else {
    rec.status = 'done';
    rec.reply = res.result || '(no reply text)';
  }
  saveAsk(rec);
  logActivity(target, `${rec.status === 'done' ? 'answered' : rec.status === 'limited' ? 'could not answer (usage limit)' : 'failed to answer'} ${caller}: ${rec.reply.replace(/\s+/g, ' ').slice(0, 140)}`, { ref: rec.id });
  if (taskId) { try { updateTask(taskId, {}, target, `Answer to ${caller} (${rec.id}): ${rec.reply.slice(0, 600)}`); } catch {} }
  return rec;
}

/** Wait up to waitS seconds for a background ask. */
export async function waitAsk(id, waitS = 0) {
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const rec = readAsk(id);
    const alive = rec.pid ? pidAlive(rec.pid) : true;
    if (rec.status === 'queued' || rec.status === 'running') {
      if (rec.pid && !alive && rec.status === 'running') {
        rec.status = 'failed'; rec.reply = 'The ask process exited without an answer.'; rec.finished_at = now(); saveAsk(rec);
        return rec;
      }
      if (Date.now() >= deadline) return rec;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    return rec;
  }
}

export function queueAsk({ target, request, readonly, taskId, timeoutS }) {
  const { caller, runtime } = preflight(target);
  const rec = { id: newAskId(), caller, target, runtime, request, readonly: !!readonly, task: taskId || null, status: 'queued', reply: null, started_at: now() };
  saveAsk(rec);
  return rec;
}

export function listAsks(limit = 20) {
  return fs.readdirSync(P.asks).filter((f) => f.endsWith('.json')).map((f) => { try { return readJson(path.join(P.asks, f)); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}
