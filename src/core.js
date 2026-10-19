import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const profileNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
export const bridgeHome = () => path.resolve(expandHome(process.env.CSB_HOME || path.join(os.homedir(), '.config', 'claude-session-bridge')));

export function expandHome(input) {
  if (typeof input !== 'string' || !input) throw new Error('A directory path is required');
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function validName(name) {
  if (!profileNamePattern.test(name || '') || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    throw new Error('Profile names must have 1-32 ASCII letters, numbers, hyphens or underscores');
  }
  return name;
}

export async function readRegistry() {
  try {
    const data = JSON.parse(await fs.readFile(path.join(bridgeHome(), 'profiles.json'), 'utf8'));
    if (data.version !== 1 || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles) || (data.active != null && typeof data.active !== 'string')) {
      throw new Error('Invalid profile registry; back up and repair profiles.json');
    }
    for (const [name, dir] of Object.entries(data.profiles)) {
      validName(name);
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(`Invalid directory for ${name}`);
    }
    if (data.active && !Object.hasOwn(data.profiles, data.active)) throw new Error('Active profile is not registered');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, profiles: {}, active: null };
    throw error;
  }
}

export async function saveRegistry(registry) {
  const root = bridgeHome();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dest = path.join(root, 'profiles.json');
  const temp = path.join(root, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, dest);
    await fs.chmod(dest, 0o600);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export function getProfile(registry, name) {
  validName(name);
  if (!Object.hasOwn(registry.profiles, name)) throw new Error(`Unknown profile '${name}'. Run: csbridge profiles add ${name} <config-dir>`);
  return registry.profiles[name];
}

export async function registerProfile(registry, name, dir) {
  validName(name);
  const resolved = expandHome(dir);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(resolved);
  const existing = registry.profiles[name];
  if (existing && (await fs.realpath(existing).catch(() => existing)) !== canonical) {
    throw new Error(`Profile '${name}' already uses a different configuration directory`);
  }
  for (const [other, folder] of Object.entries(registry.profiles)) {
    if (other !== name && (await fs.realpath(folder).catch(() => folder)) === canonical) {
      throw new Error(`Profiles '${other}' and '${name}' cannot share a config directory; they would share authentication`);
    }
  }
  registry.profiles[name] = canonical;
  await saveRegistry(registry);
  return canonical;
}

// Only inspect a bounded prefix. Claude Code's JSONL is an internal format; unknown
// records and malformed/incomplete lines are ignored rather than rewritten.
export async function sessionCwd(filename) {
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    for (const line of text.split('\n').slice(0, 300)) {
      if (!line || !line.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.cwd === 'string' && path.isAbsolute(row.cwd)) return path.resolve(row.cwd);
      } catch { /* incomplete or not JSON */ }
    }
    return null;
  } finally {
    await handle?.close();
  }
}

export async function discoverSessions(registry, names = Object.keys(registry.profiles)) {
  const sessions = [];
  for (const name of names) {
    const config = getProfile(registry, name);
    let projects;
    try { projects = await fs.readdir(path.join(config, 'projects'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of projects) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(config, 'projects', entry.name);
      for (const file of await fs.readdir(folder, { withFileTypes: true })) {
        if (!file.isFile() || !/^[\w-]+\.jsonl$/.test(file.name)) continue;
        const filename = path.join(folder, file.name);
        const stat = await fs.stat(filename);
        if (stat.size === 0) continue;
        sessions.push({ profile: name, project: entry.name, id: file.name.slice(0, -6), file: filename,
          bytes: stat.size, modified: stat.mtime, cwd: await sessionCwd(filename) });
      }
    }
  }
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function findSession(sessions, query) {
  if (!query || !/^[\w-]+$/.test(query)) throw new Error('Provide a session ID or a unique alphanumeric prefix');
  const matches = sessions.filter(s => s.id === query);
  const candidates = matches.length ? matches : sessions.filter(s => s.id.startsWith(query));
  if (!candidates.length) throw new Error(`Session not found: ${query}`);
  if (candidates.length > 1) throw new Error(`Session '${query}' is ambiguous (${candidates.length} matches). Specify --from and the full ID.`);
  return candidates[0];
}

export function matchCwd(session, cwd) {
  return session.cwd && (process.platform === 'win32' ? session.cwd.toLowerCase() === cwd.toLowerCase() : session.cwd === cwd);
}

// Copy privately through no-follow file descriptors; never mutate a source transcript.
export async function backupSession(session) {
  const directory = path.join(bridgeHome(), 'backups', session.profile, session.project);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const dest = path.join(directory, `${session.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.jsonl`);
  let input;
  let output;
  let completed = false;
  try {
    input = await fs.open(session.file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    if (!(await input.stat()).isFile()) throw new Error('The source transcript is not a regular file');
    const before = await input.stat();
    output = await fs.open(dest, 'wx', 0o600);
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Failed to write backup data');
        offset += bytesWritten;
      }
    }
    await output.sync();
    const after = await input.stat();
    const copied = await output.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copied.size !== after.size) {
      throw new Error('Transcript changed during backup. Close the original Claude session and retry.');
    }
    completed = true;
    return dest;
  } finally {
    await Promise.allSettled([input?.close(), output?.close()]);
    if (!completed) await fs.rm(dest, { force: true });
  }
}

export function parseCommand(tokens, valueFlags = [], booleanFlags = []) {
  const options = Object.create(null);
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (booleanFlags.includes(token)) {
      if (options[token]) throw new Error(`Duplicate flag: ${token}`);
      options[token] = true;
    } else if (valueFlags.includes(token)) {
      if (options[token] !== undefined) throw new Error(`Duplicate flag: ${token}`);
      if (!tokens[i + 1] || tokens[i + 1].startsWith('--')) throw new Error(`${token} requires a value`);
      options[token] = tokens[++i];
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    } else { positional.push(token); }
  }
  return { options, positional };
}
