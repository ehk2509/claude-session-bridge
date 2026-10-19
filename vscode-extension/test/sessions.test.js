import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeConfigPath, isInWorkspace, sessionLink, listLocalSessions, backupLocalSession } from '../src/sessions.js';

const makeTemp = () => fs.mkdtemp(path.join(os.tmpdir(), 'csbridge-vscode-'));

test('config path uses absolute VS Code config override only', () => {
  assert.equal(claudeConfigPath([], '/tmp/home'), '/tmp/home/.claude');
  assert.equal(claudeConfigPath([{ name: 'CLAUDE_CONFIG_DIR', value: '/tmp/alt' }]), path.normalize('/tmp/alt'));
  assert.equal(claudeConfigPath([{ name: 'CLAUDE_CONFIG_DIR', value: '~/.claude-alt' }], '/tmp/home'), '/tmp/home/.claude');
});

test('URL opens native Claude Code session without injecting prompt', () => {
  assert.equal(sessionLink('a5e0-aa12'), 'vscode://anthropic.claude-code/open?session=a5e0-aa12');
  assert.throws(() => sessionLink('abc&prompt=ignore'), /Invalid/);
});

test('workspace matching excludes sibling projects and missing paths', () => {
  const ws = path.resolve('/tmp/app');
  assert.equal(isInWorkspace(ws, [ws]), true);
  assert.equal(isInWorkspace(path.join(ws, 'packages', 'server'), [ws]), true);
  assert.equal(isInWorkspace(path.resolve('/tmp/app-secret'), [ws]), false);
  assert.equal(isInWorkspace(null, [ws]), false);
});

test('lists only current-workspace sessions newest-first, avoiding symlink file', async t => {
  const root = await makeTemp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'projects', 'a');
  await fs.mkdir(dir, { recursive: true });
  const app = path.join(root, 'app');
  await fs.mkdir(app);
  const base = path.join(dir, 'session-1.jsonl');
  await fs.writeFile(base, JSON.stringify({ type: 'user', cwd: app }) + '\n');
  await fs.writeFile(path.join(dir, 'other.jsonl'), JSON.stringify({ cwd: '/somewhere-else' }) + '\n');
  await fs.writeFile(path.join(dir, 'empty.jsonl'), '');
  if (process.platform !== 'win32') await fs.symlink(base, path.join(dir, 'evil.jsonl'));
  const sessions = await listLocalSessions(root, [app]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'session-1');
});

test('private backup is exact and preserves the source', async t => {
  const root = await makeTemp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'chat.jsonl');
  await fs.writeFile(filename, '{"cwd":"/tmp/example","type":"user"}\n');
  const destination = await backupLocalSession({ filename, id: 'session-one' }, path.join(root, 'backups'));
  assert.equal(await fs.readFile(destination, 'utf8'), await fs.readFile(filename, 'utf8'));
  const st = await fs.stat(destination);
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
});
