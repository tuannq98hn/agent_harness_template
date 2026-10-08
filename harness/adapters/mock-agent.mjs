#!/usr/bin/env node
// Mock agent runtime: lets you try the loop and dashboard without spending tokens.
// It reads the prompt file, pretends to work, and uses the harness CLI exactly like
// a real agent would (submit / review / reply in chat).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const promptFile = process.argv[2];
const prompt = fs.readFileSync(promptFile, 'utf8');
const ROOT = process.env.HARNESS_ROOT;
const cli = (...args) => execFileSync('node', [path.join(ROOT, 'harness/cli.mjs'), ...args], { encoding: 'utf8', env: process.env }).trim();
let lastSaid = 'ok';
const say = (text) => { lastSaid = text; console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })); };
const tool = (name, input) => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.MOCK_DELAY_MS || 1200);

// Simulate a CLI that was never set up in this folder (e.g. Codex asking to trust it).
const rtName = process.env.HARNESS_RUNTIME;
if (fs.existsSync(path.join(ROOT, '.harness', `MOCK_UNTRUSTED_${rtName}`))) {
  console.error('Error: Not inside a trusted directory and --skip-git-repo-check was not specified.');
  process.exit(1);
}
// Simulate a CLI that hangs waiting for an interactive answer.
if (fs.existsSync(path.join(ROOT, '.harness', `MOCK_HANG_${rtName}`))) {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

// Simulate a plan/usage limit: create .harness/MOCK_LIMIT_<runtime> (e.g. MOCK_LIMIT_mock).
if (fs.existsSync(path.join(ROOT, '.harness', `MOCK_LIMIT_${process.env.HARNESS_RUNTIME}`))) {
  // File content = the exact limit message to print (to mimic different CLI versions).
  const custom = fs.readFileSync(path.join(ROOT, '.harness', `MOCK_LIMIT_${process.env.HARNESS_RUNTIME}`), 'utf8').trim();
  console.error(custom || 'Error: You have hit your usage limit. Try again later.');
  console.log(JSON.stringify({ type: 'result', result: custom || `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, is_error: true }));
  process.exit(1);
}

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: `mock-${process.env.HARNESS_AGENT}-${Date.now()}` }));

const review = prompt.match(/# Review task (T-\d+)/);
const askReq = prompt.match(/## Mode: direct request from (\S+)[\s\S]*## Request\n([\s\S]*)$/);
// Runs a harness CLI command and returns its output even when it fails.
const tryCli = (...args) => { try { return cli(...args); } catch (e) { return `${(e.stdout || '').trim()} ${(e.stderr || '').trim()}`.trim(); } };
const task = prompt.match(/# Your task: (T-\d+)/);

if (askReq) {
  const [, caller, request] = askReq;
  tool('Bash', { command: 'git status' });
  await sleep(delay);
  const nested = request.match(/nested-ask (\S+)/);
  if (nested) say(`Tried to pass it on: ${tryCli('ask', nested[1], 'hello')}`);
  else say(`(mock ${process.env.HARNESS_AGENT} on ${process.env.HARNESS_RUNTIME}) Done for ${caller}: ${request.trim().slice(0, 120)}`);
} else if (review) {
  const id = review[1];
  tool('Bash', { command: 'git diff --stat' });
  await sleep(delay);
  say(`Reviewed ${id}: change matches the acceptance criteria.`);
  cli('task', 'review', id, '--approve', '--note', 'Mock review: looks good.');
} else if (task) {
  const id = task[1];
  say(`Reading AGENTS.md and the plan for ${id}.`);
  tool('Read', { file_path: 'AGENTS.md' });
  await sleep(delay);
  cli('task', 'note', id, 'Mock agent: implemented the change in small steps.');
  tool('Edit', { file_path: 'src/example.ts' });
  await sleep(delay);
  const bug = prompt.match(/## Bug to reproduce: (I-\d+)/);
  if (bug) {
    const rel = `docs/bugs/${bug[1]}.md`;
    fs.mkdirSync(path.join(ROOT, 'docs/bugs'), { recursive: true });
    const tpl = fs.existsSync(path.join(ROOT, 'docs/bugs/_template.md')) ? fs.readFileSync(path.join(ROOT, 'docs/bugs/_template.md'), 'utf8') : '# I-XXX\n';
    fs.writeFileSync(path.join(ROOT, rel), tpl.replace(/I-XXX/g, bug[1]).replace('<yes | no | sometimes (N of M runs)>', 'yes (5 of 5 runs)')
      .replace('1. <exact command, or exact taps: "Open app → Home → tap \'+\' → …">', '1. flutter test test/streak_test.dart --plain-name "resets at local midnight"'));
    tool('Write', { file_path: rel });
    cli('issue', 'repro', bug[1], '--file', rel, '--test', 'test/streak_test.dart');
  }
  if (/Repro report \(/.test(prompt)) {
    const f = prompt.match(/Repro report \((docs\/bugs\/I-\d+\.md)\)/)[1];
    fs.appendFileSync(path.join(ROOT, f), '\n<!-- mock fix -->\n- Root cause: mock root cause\n');
    tool('Edit', { file_path: f });
  }
  if (/needs-human/i.test(prompt)) {
    cli('task', 'block', id, '--reason', 'Mock agent: which API version should I target?');
    say('Blocked and asked the human a question.');
  } else {
    cli('task', 'submit', id, '--summary', 'Mock change done; unit tests pass locally.');
    say(`Submitted ${id}.`);
  }
} else {
  // Chat turn
  const last = prompt.split('## Message from the operator').pop().trim();
  await sleep(delay / 2);
  const askIt = last.match(/ask (\S+?):\s*(.+)/);
  if (askIt) {
    tool('Bash', { command: `node harness/cli.mjs ask ${askIt[1]} "${askIt[2]}"` });
    say(`I asked ${askIt[1]}. Answer: ${tryCli('ask', askIt[1], askIt[2])}`);
    console.log(JSON.stringify({ type: 'result', result: lastSaid, is_error: false }));
    process.exit(0);
  }
  say(`(mock ${process.env.HARNESS_AGENT}) I got your message: "${last.slice(0, 200)}". Board right now:\n${cli('task', 'list')}`);
}
console.log(JSON.stringify({ type: 'result', result: lastSaid, is_error: false }));
