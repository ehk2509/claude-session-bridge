import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { inspectHandoff, formatDiagnosticReport } from '../src/diagnostics.js';
import { hashLocalFile, backupLocalSession } from '../src/sessions.js';
import { createPendingHandoff, validatePendingHandoff } from '../src/handoff.js';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'csbridge-v3-diagnostics-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project');
  const configDir = path.join(home, 'claude-config');
  const transcript = path.join(home, 'source.jsonl');
  await fs.mkdir(cwd);
  await fs.mkdir(configDir);
  await fs.writeFile(transcript, '{"type":"user","message":"PRIVATE PROMPT SECRET"}\n');
  const session = { id: '1234-5678', cwd, filename: transcript };
  const backupPath = await backupLocalSession(session, path.join(home, 'backups'));
  const sha = await hashLocalFile(backupPath);
  const pending = createPendingHandoff(session, configDir, backupPath, 1234, sha);
  return { cwd, configDir, transcript, backupPath, sha, pending };
}

const options = f => ({ pending: f.pending, workspaces: [f.cwd], configDir: f.configDir, claudeInstalled: true, digest: hashLocalFile });

test('diagnostics verify backup integrity and do not expose conversation contents', async t => {
  const f = await fixture(t);
  const result = await inspectHandoff(options(f));
  assert.equal(result.status, 'ready');
  assert.ok(result.checks.some(item => item.code === 'backup-integrity' && item.status === 'pass'));
  const output = formatDiagnosticReport(result);
  assert.ok(!output.includes('PRIVATE PROMPT SECRET'));
  assert.ok(!output.includes(f.cwd));
  assert.ok(!output.includes(f.sha));
});

test('tampered backup fails closed without deleting source or backup', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.backupPath, '{"fake":true}\n');
  const result = await inspectHandoff(options(f));
  assert.equal(result.status, 'blocked');
  assert.ok(result.checks.some(item => item.code === 'backup-integrity' && item.status === 'fail'));
  assert.match(await fs.readFile(f.transcript, 'utf8'), /PRIVATE PROMPT SECRET/);
  assert.match(await fs.readFile(f.backupPath, 'utf8'), /fake/);
});

test('missing original transcript is reported without restoring or editing it', async t => {
  const f = await fixture(t);
  await fs.unlink(f.transcript);
  const result = await inspectHandoff(options(f));
  assert.equal(result.status, 'warning');
  assert.ok(result.checks.some(item => item.code === 'source-transcript' && item.status === 'warn'));
  assert.equal(await fs.stat(f.transcript).catch(() => null), null);
});

test('missing backup, wrong project and missing official extension block handoff', async t => {
  const f = await fixture(t);
  await fs.unlink(f.backupPath);
  const result = await inspectHandoff({ ...options(f), workspaces: [path.join(f.cwd, 'sibling')], claudeInstalled: false });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.checks.filter(item => item.status === 'fail').map(item => item.code).sort(),
    ['backup', 'claude-extension', 'project-match']);
});

test('different configuration directory is a warning, not a hidden migration', async t => {
  const f = await fixture(t);
  const result = await inspectHandoff({ ...options(f), configDir: path.join(f.cwd, 'another') });
  assert.equal(result.status, 'warning');
  assert.ok(result.checks.some(item => item.code === 'config-match' && item.status === 'warn'));
});

test('pending metadata stays backward compatible but rejects fabricated digests', async t => {
  const f = await fixture(t);
  assert.equal(validatePendingHandoff(f.pending, [f.cwd]).backupSha256, f.sha);
  const legacy = { ...f.pending };
  delete legacy.backupSha256;
  assert.equal(validatePendingHandoff(legacy, [f.cwd]).version, 1);
  assert.throws(() => validatePendingHandoff({ ...f.pending, backupSha256: '../fake' }, [f.cwd]), /invalid/);
});


test('damaged pending metadata is reported safely instead of crashing diagnostics', async t => {
  const f = await fixture(t);
  const damaged = { ...f.pending, backupPath: { malicious: true } };
  const result = await inspectHandoff({ ...options(f), pending: damaged });
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.at(-1).code, 'pending-metadata');
});
