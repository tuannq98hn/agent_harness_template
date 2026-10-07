#!/usr/bin/env node
// Harness CLI — the ONLY way agents (and scripts) should change board state.
// Usage: node harness/cli.mjs help
import {
  ensureState, addTask, updateTask, getTasks, addIssue, updateIssue, getIssues,
  getAgents, readActivity, listRoles, retryTask, createBugTasks, registerRepro, listSkills, syncSkills, loadRole, roleSkills, loadConfig, getLimits, runtimeOf, pidAlive, STATUSES, P,
} from './lib/store.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELP = `Harness CLI

Tasks
  task list [--status S] [--role R]
  task show <ID>
  task add "<title>" [--desc ..|--desc-file f] [--role implementer] [--priority P0..P3]
                     [--deps T-001,T-002] [--accept "a;b;c"] [--plan path]
  task update <ID> [--status todo|in-progress|done|pending] [--role R]
                   [--priority P] [--assignee A] [--note ..]
  task note <ID> "<text>"
  task submit <ID> --summary "<what changed + how verified>"   (agent: work finished)
  task block <ID> --reason "<question for human>"              (-> pending + issue)
  task review <ID> --approve|--reject --note "<feedback>"       (reviewer verdict)
  task retry <ID> [--note "<answer or hint>"]                    (human: requeue, reset attempts)

Issues
  issue list [--status S]
  issue show <ID>
  issue add "<title>" [--desc ..|--desc-file f] [--type bug|question|risk|blocker]
                      [--severity low|medium|high|critical] [--task T-001]
  issue update <ID> [--status S] [--assignee A] [--note ..]
  issue note <ID> "<text>"
  issue fix <ID> [--no-repro]       bug flow: "Reproduce" task (tester) -> "Fix" task (implementer)
  issue repro <ID> --file docs/bugs/<ID>.md [--test <path>|none] [--not-reproduced]   (tester)

Ask another agent directly (works across runtimes: Claude Code <-> Codex)
  agents                                   who exists, runtime, free/busy/limited
  ask <agent> "<request>" [--readonly] [--task T-001] [--timeout 540]
                                           run it now and print the answer
  ask <agent> "<request>" --background     print an ask id at once (use for long work)
  ask-result <ASK_ID> [--wait 100]         print the answer (waits up to N seconds)
  asks                                     recent asks
  Exit codes: 0 answered, 1 still running, 2 failed, 3 usage limit, 4 refused

Skills (.agents/skills/<name>/SKILL.md, mirrored to .claude/skills)
  skills list [--role R]            all skills, or the ones recommended for a role
  skills sync                       copy .agents/skills -> .claude/skills (Claude Code)

Other
  roles             list agent role definitions (agents/*.md)
  activity [N]      last N activity entries
  init              create .harness/ state files

Statuses: ${STATUSES.join(', ')}
Actor is taken from $HARNESS_AGENT (set automatically for agents) or "human".`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) flags[k] = true;
      else { flags[k] = nxt; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const actor = process.env.HARNESS_AGENT || 'human';
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const fmtTask = (t) => `${t.id}  [${t.status}]  ${t.priority}  ${t.role}${t.assignee ? `@${t.assignee}` : ''}  ${t.title}`;
const fmtIssue = (i) => `${i.id}  [${i.status}]  ${i.severity}  ${i.type}${i.task ? ` (${i.task})` : ''}${i.repro ? (i.repro.reproduced ? '  [reproduced]' : '  [not reproduced]') : ''}  ${i.title}`;
const descOf = (flags) => (typeof flags['desc-file'] === 'string' ? fs.readFileSync(flags['desc-file'], 'utf8') : typeof flags.desc === 'string' ? flags.desc : '');
const list = (v) => (typeof v === 'string' ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);

function main() {
  ensureState();
  const [group, cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);

  if (!group || group === 'help' || group === '--help') return out(HELP);
  if (group === 'init') return out(`State ready in ${P.tasks.replace(/tasks\.json$/, '')}`);
  if (group === 'agents') {
    const cfg = loadConfig();
    const st = getAgents();
    const limits = getLimits();
    return out(cfg.agents.map((a) => {
      const rt = runtimeOf(cfg, a);
      const x = st[a.id] || {};
      const state = a.enabled === false ? 'disabled' : limits[rt] ? 'limited' : x.status === 'running' && pidAlive(x.owner_pid) ? 'busy' : 'free';
      return `${a.id.padEnd(14)} ${a.role.padEnd(14)} ${rt.padEnd(8)} ${state.padEnd(9)} ${x.current_task || '-'}  ${state === 'busy' ? x.last_message || '' : ''}`;
    }).join('\n'));
  }
  if (group === 'roles') return out(listRoles().join('\n'));
  if (group === 'skills') {
    if (cmd === 'sync') { const r = syncSkills(); return out(`synced ${r.synced} skill(s) to .claude/skills${r.removed ? `, removed ${r.removed} stale` : ''}`); }
    let list = listSkills();
    const { flags: f } = parse(process.argv.slice(4));
    const roleName = typeof flags.role === 'string' ? flags.role : f.role;
    if (roleName) { const want = roleSkills(loadRole(roleName).meta); list = list.filter((x) => want.includes(x.name)); }
    return out(list.map((x) => `${x.name.padEnd(30)} ${x.path}\n  ${x.description}`).join('\n') || '(no skills in .agents/skills)');
  }
  if (group === 'activity') return out(readActivity(Number(cmd) || 30).map((e) => `${e.at}  ${e.by}: ${e.text}`).join('\n'));

  if (group === 'task') {
    switch (cmd) {
      case 'list': {
        let ts = getTasks();
        if (flags.status) ts = ts.filter((t) => t.status === flags.status);
        if (flags.role) ts = ts.filter((t) => t.role === flags.role);
        return out(ts.map(fmtTask).join('\n') || '(no tasks)');
      }
      case 'show': {
        const t = getTasks().find((x) => x.id === pos[0]);
        if (!t) throw new Error(`Task ${pos[0]} not found`);
        return out(t);
      }
      case 'add': {
        if (!pos[0]) throw new Error('task add needs a title');
        const t = addTask({
          title: pos[0], description: descOf(flags), role: flags.role, priority: flags.priority,
          depends_on: list(flags.deps), acceptance: list(flags.accept), plan: flags.plan || null,
          status: flags.status,
        }, actor);
        return out(`created ${fmtTask(t)}`);
      }
      case 'update': {
        const patch = {};
        for (const k of ['status', 'role', 'priority', 'assignee', 'title']) if (typeof flags[k] === 'string') patch[k] = flags[k];
        if (flags.status === 'todo') {
          const before = getTasks().find((t) => t.id === pos[0]);
          Object.assign(patch, { assignee: null, submitted: false, pending_reason: null, review: null });
          if (before?.status === 'pending' && actor === 'human') {
            patch.attempts = 0;
            for (const i of getIssues()) if (i.task === pos[0] && i.type === 'blocker' && i.status !== 'done') updateIssue(i.id, { status: 'done' }, actor, `Resolved when ${pos[0]} went back to todo`);
          }
        }
        const t = updateTask(pos[0], patch, actor, typeof flags.note === 'string' ? flags.note : undefined);
        return out(`updated ${fmtTask(t)}`);
      }
      case 'note': {
        const t = updateTask(pos[0], {}, actor, pos.slice(1).join(' ') || flags.note);
        return out(`noted on ${t.id}`);
      }
      case 'submit': {
        const summary = typeof flags.summary === 'string' ? flags.summary : pos.slice(1).join(' ');
        if (!summary) throw new Error('task submit needs --summary');
        const t = updateTask(pos[0], { submitted: true }, actor, `SUBMITTED: ${summary}`);
        return out(`submitted ${t.id} — the loop will run the quality gate and review`);
      }
      case 'block': {
        const reason = typeof flags.reason === 'string' ? flags.reason : pos.slice(1).join(' ');
        if (!reason) throw new Error('task block needs --reason');
        const i = addIssue({ title: `${pos[0]} blocked: ${reason.slice(0, 80)}`, description: reason, type: 'blocker', severity: 'high', task: pos[0] }, actor);
        const t = updateTask(pos[0], { status: 'pending', pending_reason: reason, submitted: false }, actor, `BLOCKED (${i.id}): ${reason}`);
        return out(`${t.id} is pending, opened ${i.id}`);
      }
      case 'review': {
        const note = typeof flags.note === 'string' ? flags.note : '';
        if (!flags.approve && !flags.reject) throw new Error('task review needs --approve or --reject');
        const verdict = flags.approve ? 'approved' : 'rejected';
        const t = updateTask(pos[0], { review: verdict }, actor, `REVIEW ${verdict.toUpperCase()}: ${note}`);
        return out(`${t.id} review ${verdict}`);
      }
      case 'retry': {
        const t = retryTask(pos[0], actor, typeof flags.note === 'string' ? flags.note : undefined);
        return out(`${t.id} is back in todo with a fresh attempt budget`);
      }
      default: throw new Error(`Unknown task command "${cmd}"\n\n${HELP}`);
    }
  }

  if (group === 'issue') {
    switch (cmd) {
      case 'list': {
        let is = getIssues();
        if (flags.status) is = is.filter((i) => i.status === flags.status);
        return out(is.map(fmtIssue).join('\n') || '(no issues)');
      }
      case 'show': {
        const i = getIssues().find((x) => x.id === pos[0]);
        if (!i) throw new Error(`Issue ${pos[0]} not found`);
        return out(i);
      }
      case 'add': {
        if (!pos[0]) throw new Error('issue add needs a title');
        const i = addIssue({ title: pos[0], description: descOf(flags), type: flags.type, severity: flags.severity, task: flags.task || null }, actor);
        return out(`opened ${fmtIssue(i)}`);
      }
      case 'update': {
        const patch = {};
        for (const k of ['status', 'assignee', 'severity', 'type', 'title']) if (typeof flags[k] === 'string') patch[k] = flags[k];
        const i = updateIssue(pos[0], patch, actor, typeof flags.note === 'string' ? flags.note : undefined);
        return out(`updated ${fmtIssue(i)}`);
      }
      case 'note': {
        const i = updateIssue(pos[0], {}, actor, pos.slice(1).join(' ') || flags.note);
        return out(`noted on ${i.id}`);
      }
      case 'fix': {
        const r = createBugTasks(pos[0], { repro: !flags['no-repro'] }, actor);
        return out(r.repro ? `${r.repro.id} reproduce (tester) -> ${r.fix.id} fix (implementer)` : `fix task ${r.fix.id}`);
      }
      case 'repro': {
        const test = typeof flags.test === 'string' && flags.test !== 'none' ? flags.test : null;
        const i = registerRepro(pos[0], { file: flags.file, test, reproduced: !flags['not-reproduced'] }, actor);
        return out(`${i.id}: repro ${i.repro.reproduced ? 'registered' : 'marked NOT reproduced'} (${i.repro.file})`);
      }
      default: throw new Error(`Unknown issue command "${cmd}"\n\n${HELP}`);
    }
  }
  throw new Error(`Unknown command "${group}"\n\n${HELP}`);
}

// ---------- agent-to-agent asks (async) ----------
async function askMain(group, rest) {
  const { pos, flags } = parse(rest);
  const A = await import('./lib/ask.mjs');
  ensureState();
  if (group === 'asks') {
    return out(A.listAsks(Number(pos[0]) || 20).map((r) => `${r.id}  ${r.status.padEnd(8)} ${r.caller} → ${r.target} (${r.runtime})  ${r.request.replace(/\s+/g, ' ').slice(0, 70)}`).join('\n') || '(no asks)');
  }
  if (group === 'ask-result') {
    if (!pos[0]) throw new Error('ask-result needs an ask id');
    const r = await A.waitAsk(pos[0], Number(flags.wait) || 0);
    if (r.status === 'queued' || r.status === 'running') {
      out(`${r.id} is still running (${r.target}). Run "node harness/cli.mjs ask-result ${r.id} --wait 100" again.`);
      return A.EXIT.running;
    }
    out(r.reply);
    return A.EXIT[r.status === 'done' ? 'ok' : r.status] ?? A.EXIT.failed;
  }
  // ask
  const target = pos[0];
  const request = pos.slice(1).join(' ') || (typeof flags.request === 'string' ? flags.request : '');
  if (!target || !request) throw new Error('usage: ask <agent> "<request>" [--readonly] [--task T-001] [--background]');
  const opts = { target, request, readonly: !!flags.readonly, taskId: typeof flags.task === 'string' ? flags.task : null, timeoutS: Number(flags.timeout) || undefined };
  if (flags.background) {
    const rec = A.queueAsk(opts);
    const args = [fileURLToPath(import.meta.url), 'ask', target, request, '--id', rec.id];
    if (opts.readonly) args.push('--readonly');
    if (opts.taskId) args.push('--task', opts.taskId);
    if (opts.timeoutS) args.push('--timeout', String(opts.timeoutS));
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    out(`${rec.id} started: ${target} is working on it. Collect the answer with: node harness/cli.mjs ask-result ${rec.id} --wait 100`);
    return A.EXIT.ok;
  }
  try {
    const rec = await A.runAsk({ ...opts, id: typeof flags.id === 'string' ? flags.id : undefined });
    if (rec.status === 'done') out(rec.reply); else console.error(`[harness] ${rec.reply}`);
    return A.EXIT[rec.status === 'done' ? 'ok' : rec.status] ?? A.EXIT.failed;
  } catch (e) {
    // A background child that is refused still has to leave a result behind.
    if (typeof flags.id === 'string') {
      try {
        const f = `${P.asks}/${flags.id}.json`;
        const { readJson, writeJson, now } = await import('./lib/store.mjs');
        writeJson(f, { ...readJson(f), status: 'failed', reply: e.message, finished_at: now() });
      } catch {}
    }
    throw e;
  }
}

const first = process.argv[2];
if (['ask', 'ask-result', 'asks'].includes(first)) {
  askMain(first, process.argv.slice(3)).then((code) => process.exit(code || 0)).catch((e) => {
    console.error(`[harness] ${e.message}`);
    process.exit(e.exit || 1);
  });
} else {
  try {
    main();
  } catch (e) {
    console.error(`[harness] ${e.message}`);
    process.exit(1);
  }
}
