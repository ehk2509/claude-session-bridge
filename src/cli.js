#!/usr/bin/env node
/** Claude Session Bridge CLI: no credential files are read or copied. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  backupSession, bridgeHome, discoverSessions, expandHome, findSession,
  getProfile, matchCwd, parseCommand, readRegistry, registerProfile, saveRegistry
} from './core.js';

const BLOCKED_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function usage() {
  console.log(`Claude Session Bridge v0.1.0

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
  csbridge backup <id-prefix|latest> --from A
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
  const destination = getProfile(registry, target);
  if (session.profile === target) throw new Error('Source and target must be different profiles. Use csbridge start to continue within one profile.');
  const cwd = await projectDirectory(cwdFlag, session);
  const backup = await backupSession(session);
  console.log(`Source profile: ${session.profile}\nDestination profile: ${target}\nSession: ${session.id}\nProject directory: ${cwd}\nPrivate backup: ${backup}`);
  console.log('Starting a fork. Original session remains unchanged.');
  const status = launch(['--resume', session.file, '--fork-session'], destination, cwd);
  if (status === 0) { registry.active = target; await saveRegistry(registry); }
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
    console.log(`Backup saved: ${await backupSession(target)}`);
    return;
  }
  if (command === 'resume') {
    const { positional, options } = parseCommand(rest, ['--from', '--to', '--cwd']);
    ensureOnly(positional, 1, 1, 'csbridge resume <id-prefix|latest> --from A --to B [--cwd DIR]');
    if (!options['--from'] || !options['--to']) throw new Error('resume requires --from and --to');
    const list = await discoverSessions(registry, [options['--from']]);
    return handoff(registry, pick(list, positional[0]), options['--to'], options['--cwd']);
  }
  if (command === 'switch') {
    const { positional, options } = parseCommand(rest, ['--from', '--session', '--cwd']);
    ensureOnly(positional, 1, 1, 'csbridge switch <target> [--from A] [--session ID] [--cwd DIR]');
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
      if (!session) throw new Error(`No session for ${cwd} in source profile(s) ${names.join(', ')}. Use csbridge sessions and --session ID, or --from PROFILE.`);
    }
    return handoff(registry, session, target, options['--cwd']);
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
    return;
  }
  throw new Error(`Unknown command '${command}'. Run csbridge help.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
