/** Local CLI handoff safety and recovery. No credentials or transcript text in reports. */
import fs from 'node:fs/promises';
import { constants as c } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backupSession, bridgeHome } from './core.js';

const pendingFile = () => path.join(bridgeHome(), 'pending-handoff.json');
const sidecar = file => file + '.sha256.json';
const underBackupRoot = file => {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.join(bridgeHome(), 'backups'), file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

async function readNoFollow(file) {
  const handle = await fs.open(file, c.O_RDONLY | (c.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Expected a regular file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function digest(file) {
  const handle = await fs.open(file, c.O_RDONLY | (c.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Expected a regular file');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('File changed while hashing; close the source session and retry');
    }
    return { sha256: hash.digest('hex'), size: after.size };
  } finally { await handle.close(); }
}

export async function createVerifiedBackup(session) {
  const file = await backupSession(session);
  let success = false;
  try {
    const backup = await digest(file);
    const source = await digest(session.file);
    if (source.sha256 !== backup.sha256 || source.size !== backup.size) {
      throw new Error('Session changed after backup. Close the source and retry.');
    }
    const manifest = { version: 1, algorithm: 'sha256', ...backup, createdAt: new Date().toISOString() };
    await fs.writeFile(sidecar(file), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    success = true;
    return { file, ...backup };
  } finally {
    if (!success) {
      await fs.rm(sidecar(file), { force: true });
      await fs.rm(file, { force: true });
    }
  }
}

export async function verifyBackup(file) {
  if (!underBackupRoot(file) || !file.endsWith('.jsonl')) throw new Error('Backup must be a managed .jsonl snapshot.');
  let manifest;
  try { manifest = JSON.parse(await readNoFollow(sidecar(file))); }
  catch { throw new Error('Backup checksum manifest is missing or invalid.'); }
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new Error('Backup checksum manifest is invalid.');
  }
  let found;
  try { found = await digest(file); }
  catch { throw new Error('Backup is missing or unreadable.'); }
  if (found.sha256 !== manifest.sha256 || found.size !== manifest.size) {
    throw new Error('Backup integrity mismatch: snapshot was modified. Do not restore from it.');
  }
  return { file, ...found };
}

export async function readPending() {
  let pending;
  try { pending = JSON.parse(await readNoFollow(pendingFile())); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Pending handoff metadata is invalid or unreadable; do not overwrite it.');
  }
  if (!pending || pending.version !== 1 || !pending.source || !pending.target ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(pending.source) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(pending.target) ||
      pending.source === pending.target || !/^[\w-]+$/.test(pending.sessionId || '') ||
      !underBackupRoot(pending.backup) || !path.isAbsolute(pending.sessionFile || '') ||
      !path.isAbsolute(pending.cwd || '') || typeof pending.createdAt !== 'string') {
    throw new Error('Pending handoff metadata is invalid; do not overwrite it.');
  }
  return pending;
}

export async function savePending(pending) {
  await fs.mkdir(bridgeHome(), { recursive: true, mode: 0o700 });
  await fs.writeFile(pendingFile(), JSON.stringify(pending, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
}

export async function completePending() {
  const pending = await readPending();
  if (!pending) throw new Error('No pending handoff.');
  await verifyBackup(pending.backup);
  await fs.unlink(pendingFile());
}

export async function diagnosePending(pending, registry) {
  if (!pending) return { status: 'ready', checks: [{ status: 'info', code: 'pending', message: 'No pending handoff.' }] };
  const checks = [];
  const add = (code, status, message) => checks.push({ code, status, message });
  add('source-profile', Object.hasOwn(registry.profiles, pending.source) ? 'pass' : 'fail',
    'Source profile is ' + (Object.hasOwn(registry.profiles, pending.source) ? 'registered.' : 'missing.'));
  add('target-profile', Object.hasOwn(registry.profiles, pending.target) ? 'pass' : 'fail',
    'Destination profile is ' + (Object.hasOwn(registry.profiles, pending.target) ? 'registered.' : 'missing.'));
  const folder = await fs.stat(pending.cwd).catch(() => null);
  add('workspace', folder?.isDirectory() ? 'pass' : 'fail',
    folder?.isDirectory() ? 'Original workspace exists.' : 'Original workspace is missing; use the original checkout.');
  const source = await fs.lstat(pending.sessionFile).catch(() => null);
  add('source-session', source?.isFile() ? 'pass' : 'warn',
    source?.isFile() ? 'Original session file exists.' : 'Original session missing; native resume may fail.');
  try {
    await verifyBackup(pending.backup);
    add('backup-integrity', 'pass', 'Private backup SHA-256 verified.');
  } catch {
    add('backup-integrity', 'fail', 'Private backup is missing, unreadable, or changed.');
  }
  return { status: checks.some(x => x.status === 'fail') ? 'blocked' :
      checks.some(x => x.status === 'warn') ? 'warning' : 'ready', checks };
}

export function safeReport(report) {
  const lines = ['CLI handoff diagnostics — ' + report.status];
  for (const check of report.checks) lines.push('[' + check.status.toUpperCase() + '] ' +
    check.code + ': ' + check.message);
  lines.push('No credentials or conversation content were inspected or included.');
  return lines.join('\n');
}
