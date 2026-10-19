// All operations are local, read-only unless an explicit backup is requested.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function claudeConfigPath(envVars, home = os.homedir()) {
  const configured = Array.isArray(envVars)
    ? envVars.find(item => item?.name === 'CLAUDE_CONFIG_DIR')?.value
    : undefined;
  return typeof configured === 'string' && path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.join(home, '.claude');
}

export function sessionLink(id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`;
}

export function isInWorkspace(cwd, workspaceFolders) {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  const comparison = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  return (workspaceFolders || []).some(folder => {
    if (!folder || !path.isAbsolute(folder)) return false;
    // Anthropic's URL handler requires this exact workspace; a parent folder
    // is insufficient and could otherwise silently open a new chat.
    return path.resolve(comparison(folder)) === path.resolve(comparison(cwd));
  });
}

async function recordedCwd(filename) {
  let input;
  try {
    input = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const first = Buffer.alloc(256 * 1024);
    const { bytesRead } = await input.read(first, 0, first.byteLength, 0);
    for (const line of first.toString('utf8', 0, bytesRead).split('\n').slice(0, 300)) {
      if (!line.includes('"cwd"')) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) return record.cwd;
      } catch { /* Ignore incomplete or non-JSON records. */ }
    }
    return null;
  } finally { await input?.close(); }
}

export async function listLocalSessions(configDir, workspaces) {
  const projects = path.join(configDir, 'projects');
  const results = [];
  const folders = await fs.readdir(projects, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dirname = path.join(projects, folder.name);
    const files = await fs.readdir(dirname, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !/^[\w-]+\.jsonl$/.test(file.name)) continue;
      const filename = path.join(dirname, file.name);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size === 0) continue;
      const cwd = await recordedCwd(filename);
      if (!isInWorkspace(cwd, workspaces)) continue;
      results.push({ id: file.name.slice(0, -6), filename, cwd, modified: stat.mtime, bytes: stat.size });
    }
  }
  return results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Back up without following symlinks or overwriting an existing file. */
export async function backupLocalSession(session, root = path.join(os.homedir(), '.config', 'claude-session-bridge', 'vscode-backups')) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, `${session.id}-${Date.now()}-${randomUUID()}.jsonl`);
  let source;
  let target;
  let finished = false;
  try {
    source = await fs.open(session.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await source.stat();
    if (!before.isFile()) throw new Error('Source is not a regular file');
    target = await fs.open(destination, 'wx', 0o600);
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Incomplete backup write');
        offset += bytesWritten;
      }
    }
    await target.sync();
    const after = await source.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (await target.stat()).size !== before.size) {
      throw new Error('Source transcript changed during backup. Close the Claude tab and retry.');
    }
    finished = true;
    return destination;
  } finally {
    await Promise.allSettled([source?.close(), target?.close()]);
    if (!finished) await fs.rm(destination, { force: true });
  }
}
