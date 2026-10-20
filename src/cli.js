#!/usr/bin/env node
/** Claude Session Bridge CLI: no credential files are read or copied. */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  bridgeHome, discoverSessions, expandHome, findSession,
  getProfile, matchCwd, parseCommand, readRegistry, registerProfile, saveRegistry
} from './core.js';
import { createVerifiedBackup, verifyBackup, readPending, savePending,
  completePending, diagnosePending, safeReport } from './recovery.js';

const BLOCKED_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function usage() {
  console.log(`Claude Session Bridge CLI v0.2.1

Account profiles:
  csbridge profiles add <name> <config-dir>   Register an isolated Claude config
  csbridge profiles list                      List profiles and active profile
  csbridge profiles use <name>                Set default source profile
  csbridge profiles remove <name>             Forget profile (never deletes data)
  csbridge auth <profile>                      Authenticate via Claude's own login
  csbridge start [profile]                     Start Claude with selected profile

Session handoff:
  csbridge sessions [profile] [--cwd DIR] [--limit N]
  csbridge resume <id-prefix|latest> --from A --to B [--cwd DIR]
  csbridge switch <target> [--from A] [--session ID] [--cwd DIR]
  csbridge quick <target> [--from A] [--session ID] [--cwd DIR] [--yes]
  csbridge backup <id-prefix|latest> --from A
  csbridge verify <managed-backup-path>
  csbridge pending                 Check local handoff and SHA-256 integrity
  csbridge retry                   Retry saved handoff (no new backup)
  csbridge finish --confirmed      Mark restored only after checking history
  csbridge doctor

Example:
  csbridge profiles add work ~/.claude
  csbridge profiles add personal ~/.claude-personal
  csbridge auth personal
  cd ~/projects/my-app
  csbridge switch personal --from work

A handoff makes a private backup, then uses Claude Code's native
--resume <absolute-transcript-path> --fork-session. Close the source
session first. The original transcript and accounts remain untouched.
Quick requires confirmation (or --yes for explicit automation).
Pending handoffs survive process exits. Confirm continuity before finish.
`);
}

function claudeCommand(args) {
  const executable = process.env.CSB_CLAUDE_BIN || 'claude';
  return /\.(?:m?js|cjs)$/.test(executable)
    ? [process.execPath, [executable, ...args]]
    : [executable, args];
}

function launch(args, configDir, cwd = process.cwd()) {
  const present = BLOCKED_AUTH_ENV.filter(name => process.env[name]);
  if (present.length) throw new Error(`Account identity is ambiguous: unset ${present.join(', ')} before launching Claude through a profile`);
  const [binary, binaryArgs] = claudeCommand(args);
  const result = spawnSync(binary, binaryArgs, {
    cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: 'inherit'
  });
  if (result.error) throw new Error(`Unable to launch Claude Code: ${result.error.message}`);
  if (result.signal) throw new Error(`Claude Code terminated by ${result.signal}`);
  const status = result.status ?? 1;
  process.exitCode = status;
  return status;
}

function ensureOnly(positional, min, max, hint) {
  if (positional.length < min || positional.length > max) throw new Error(`Usage: ${hint}`);
}

function pick(sessions, key) {
  if (key === 'latest') {
    if (!sessions.length) throw new Error('No sessions available');
    return sessions[0];
  }
  return findSession(sessions, key);
}

async function projectDirectory(opt, session) {
  const cwd = opt ? expandHome(opt) : (session.cwd || process.cwd());
  if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) {
    throw new Error(`Project directory does not exist: ${cwd}. Pass --cwd with the current checkout location.`);
  }
  return await fs.realpath(cwd);
}

async function handoff(registry, session, target, cwdFlag) {
  if (await readPending()) throw new Error('A handoff is pending. Run csbridge pending / retry / finish before starting another.');
  const destination = getProfile(registry, target);
  if (session.profile === target) throw new Error('Source and target must be different profiles. Use csbridge start within one profile.');
  const cwd = await projectDirectory(cwdFlag, session);
  const backup = await createVerifiedBackup(session);
  const pending = { version: 1, source: session.profile, target, sessionId: session.id,
    sessionFile: session.file, cwd, backup: backup.file, createdAt: new Date().toISOString() };
  await savePending(pending);
  await verifyBackup(backup.file);
  console.log('Session: ' + session.id);
  console.log('Source: ' + session.profile + ' => destination: ' + target);
  console.log('Private verified backup saved. Starting native Claude Code fork.');
  const status = launch(['--resume', session.file, '--fork-session'], destination, cwd);
  if (status === 0) {
    registry.active = target;
    await saveRegistry(registry);
  }
  console.log('Handoff remains pending. Inspect the reopened conversation, then run csbridge finish --confirmed.');
}

async function retryHandoff(registry) {
  const pending = await readPending();
  if (!pending) throw new Error('No pending handoff. Start with csbridge quick or switch.');
  const report = await diagnosePending(pending, registry);
  console.log(safeReport(report));
  if (report.status !== 'ready') throw new Error('Pending handoff is not safe to retry; inspect csbridge pending.');
  const destination = getProfile(registry, pending.target);
  const status = launch(['--resume', pending.sessionFile, '--fork-session'], destination, pending.cwd);
  if (status === 0) {
    registry.active = pending.target;
    await saveRegistry(registry);
  }
  console.log('Handoff still pending. Confirm conversation continuity, then csbridge finish --confirmed.');
}

async function confirmSelectedSession(session, target) {
  console.log('Source profile: ' + session.profile);
  console.log('Destination profile: ' + target);
  console.log('Suggested session ID: ' + session.id);
  console.log('Recorded project: ' + (session.cwd || '(unknown)'));
  console.log('This suggestion is based on the latest saved transcript, not the active chat.');
  if (!process.stdin.isTTY) throw new Error('Interactive confirmation unavailable. Review the session and pass --yes explicitly.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Source conversation is closed and selection correct? [y/N] ');
    if (!/^(y|yes)$/i.test(answer.trim())) throw new Error('Handoff cancelled; source session not changed.');
  } finally { rl.close(); }
}

export async function main(argv) {
  if (!argv.length || ['help', '-h', '--help'].includes(argv[0])) return usage();
  const registry = await readRegistry();
  const [command, ...rest] = argv;
  if (command === 'profiles') {
    const [action, ...tokens] = rest;
    const { positional } = parseCommand(tokens);
    if (action === 'list') {
      ensureOnly(positional, 0, 0, 'csbridge profiles list');
      if (!Object.keys(registry.profiles).length) return console.log('No profiles. Use: csbridge profiles add work ~/.claude');
      for (const [name, dir] of Object.entries(registry.profiles)) console.log(`${registry.active === name ? '* ' : '  '}${name}\t${dir}`);
      return;
    }
    if (action === 'add') {
      ensureOnly(positional, 2, 2, 'csbridge profiles add <name> <config-dir>');
      const dir = await registerProfile(registry, positional[0], positional[1]);
      if (!registry.active) { registry.active = positional[0]; await saveRegistry(registry); }
      console.log(`Registered '${positional[0]}' at ${dir}. Sign in using: csbridge auth ${positional[0]}`);
      return;
    }
    if (action === 'use') {
      ensureOnly(positional, 1, 1, 'csbridge profiles use <name>');
      getProfile(registry, positional[0]); registry.active = positional[0]; await saveRegistry(registry);
      console.log(`Active bridge profile: ${registry.active}`);
      return;
    }
    if (action === 'remove') {
      ensureOnly(positional, 1, 1, 'csbridge profiles remove <name>');
      getProfile(registry, positional[0]);
      delete registry.profiles[positional[0]];
      if (registry.active === positional[0]) registry.active = null;
      await saveRegistry(registry);
      console.log(`Unregistered '${positional[0]}'. Claude credentials and sessions on disk were not deleted.`);
      return;
    }
    throw new Error('Use csbridge profiles add|list|use|remove');
  }
  if (command === 'auth' || command === 'start') {
    const { positional } = parseCommand(rest);
    ensureOnly(positional, command === 'auth' ? 1 : 0, 1, `csbridge ${command} <profile>`);
    const profile = positional[0] || registry.active;
    if (!profile) throw new Error('No active profile; use csbridge profiles use <name>');
    const code = launch(command === 'auth' ? ['auth', 'login'] : [], getProfile(registry, profile));
    if (code === 0 && command === 'start') { registry.active = profile; await saveRegistry(registry); }
    return;
  }
  if (command === 'sessions') {
    const { positional, options } = parseCommand(rest, ['--cwd', '--limit']);
    ensureOnly(positional, 0, 1, 'csbridge sessions [profile] [--cwd DIR] [--limit N]');
    const limit = options['--limit'] === undefined ? 20 : Number(options['--limit']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer from 1 to 1000');
    const list = await discoverSessions(registry, positional.length ? [positional[0]] : undefined);
    const cwd = options['--cwd'] && await fs.realpath(expandHome(options['--cwd'])).catch(() => expandHome(options['--cwd']));
    const filtered = cwd ? list.filter(s => matchCwd(s, cwd)) : list;
    if (!filtered.length) return console.log('No matching local sessions found.');
    console.log('PROFILE         UPDATED              SESSION ID                              PROJECT (recorded cwd)');
    for (const s of filtered.slice(0, limit)) {
      console.log(`${s.profile.padEnd(16)}${s.modified.toISOString().slice(0, 19).padEnd(21)}${s.id.padEnd(40)}${s.cwd || s.project}`);
    }
    if (filtered.length > limit) console.log(`Showing ${limit} of ${filtered.length}; increase --limit to see more.`);
    return;
  }
  if (command === 'backup') {
    const { positional, options } = parseCommand(rest, ['--from']);
    ensureOnly(positional, 1, 1, 'csbridge backup <id-prefix|latest> --from PROFILE');
    if (!options['--from']) throw new Error('backup requires --from <profile>');
    const list = await discoverSessions(registry, [options['--from']]);
    const target = pick(list, positional[0]);
    const snapshot = await createVerifiedBackup(target);
    console.log('Private backup saved and verified: ' + snapshot.file);
    return;
    return;
  }
  if (command === 'resume') {
    const { positional, options } = parseCommand(rest, ['--from', '--to', '--cwd']);
    ensureOnly(positional, 1, 1, 'csbridge resume <id-prefix|latest> --from A --to B [--cwd DIR]');
    if (!options['--from'] || !options['--to']) throw new Error('resume requires --from and --to');
    const list = await discoverSessions(registry, [options['--from']]);
    return handoff(registry, pick(list, positional[0]), options['--to'], options['--cwd']);
  }
  if (command === 'switch' || command === 'quick') {
    const { positional, options } = parseCommand(rest, ['--from', '--session', '--cwd'], ['--yes']);
    ensureOnly(positional, 1, 1, 'csbridge ' + command + ' <target> [--from A] [--session ID] [--cwd DIR]' +
      (command === 'quick' ? ' [--yes]' : ''));
    if (command === 'switch' && options['--yes']) throw new Error('--yes is only valid with csbridge quick');
    const target = positional[0]; getProfile(registry, target);
    const from = options['--from'];
    const names = from ? [from] : (registry.active && registry.active !== target
      ? [registry.active] : Object.keys(registry.profiles).filter(n => n !== target));
    if (!names.length) throw new Error('No source profile. Specify --from <profile>');
    const list = await discoverSessions(registry, names);
    let session;
    if (options['--session']) {
      session = pick(list, options['--session']);
    } else {
      const providedCwd = expandHome(options['--cwd'] || process.cwd());
      const cwd = await fs.realpath(providedCwd).catch(() => providedCwd);
      session = list.find(s => matchCwd(s, cwd));
      if (!session) throw new Error('No session for this project. Run csbridge sessions and provide --session ID or --from PROFILE.');
    }
    if (command === 'quick' && !options['--yes']) await confirmSelectedSession(session, target);
    return handoff(registry, session, target, options['--cwd']);
  }
  if (command === 'pending') {
    ensureOnly(parseCommand(rest).positional, 0, 0, 'csbridge pending');
    const report = await diagnosePending(await readPending(), registry);
    console.log(safeReport(report));
    if (report.status === 'blocked') process.exitCode = 1;
    return;
  }
  if (command === 'retry') {
    ensureOnly(parseCommand(rest).positional, 0, 0, 'csbridge retry');
    return retryHandoff(registry);
  }
  if (command === 'finish') {
    const { positional, options } = parseCommand(rest, [], ['--confirmed']);
    ensureOnly(positional, 0, 0, 'csbridge finish --confirmed');
    if (!options['--confirmed']) throw new Error('Verify previous messages and task continuity first, then pass --confirmed.');
    await completePending();
    console.log('Handoff confirmed; pending record cleared. Private backup retained.');
    return;
  }
  if (command === 'verify') {
    const { positional } = parseCommand(rest);
    ensureOnly(positional, 1, 1, 'csbridge verify <managed-backup-path>');
    await verifyBackup(expandHome(positional[0]));
    console.log('Private backup SHA-256 verified.');
    return;
  }
  if (command === 'doctor') {
    ensureOnly(parseCommand(rest).positional, 0, 0, 'csbridge doctor');
    const [binary, binaryArgs] = claudeCommand(['--version']);
    const result = spawnSync(binary, binaryArgs, { encoding: 'utf8' });
    console.log(`Claude Code: ${result.error ? 'not found' : (result.stdout || result.stderr || `exit ${result.status}`).trim()}`);
    console.log(`Bridge home: ${bridgeHome()}\nProfiles: ${Object.keys(registry.profiles).length}\nActive: ${registry.active || '(none)'}`);
    for (const [name, dir] of Object.entries(registry.profiles)) {
      const st = await fs.stat(dir).catch(() => null);
      console.log(`  ${name}: ${st?.isDirectory() ? 'present' : 'MISSING'} — ${dir}`);
    }
    for (const key of BLOCKED_AUTH_ENV) if (process.env[key]) console.log(`WARNING: ${key} is set and prevents profile-safe launches.`);
    console.log(safeReport(await diagnosePending(await readPending(), registry)));
    return;
  }
  throw new Error(`Unknown command '${command}'. Run csbridge help.`);
}

// npm installs 'csbridge' as a symlink. Compare canonical paths so the
// terminal entry point executes, while importing this module stays inert.
let invokedAsCli = false;
if (process.argv[1]) {
  try { invokedAsCli = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { /* Not a file executed as this entry point. */ }
}
if (invokedAsCli) {
  main(process.argv.slice(2)).catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
