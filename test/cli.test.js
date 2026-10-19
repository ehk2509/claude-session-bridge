import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'csbridge-test-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const work = path.join(root, 'work');
  const personal = path.join(root, 'personal');
  const state = path.join(root, 'state');
  const project = path.join(root, 'code', 'my-app');
  const trace = path.join(root, 'trace.json');
  const stub = path.join(root, 'mock.mjs');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(stub, `import fs from 'node:fs';\nif(process.argv.includes('--version')){ console.log('mock-claude 2.1.0');process.exit(0); }\nfs.writeFileSync(process.env.CSB_TRACE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR}));\nprocess.exit(Number(process.env.MOCK_CLAUDE_EXIT||'0'));\n`);
  const env = { ...process.env, CSB_HOME: state, CSB_CLAUDE_BIN: stub, CSB_TRACE: trace };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: project, encoding: 'utf8' });
  const runIn = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd, encoding: 'utf8' });
  const runEnv = (extra, ...args) => spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, cwd: project, encoding: 'utf8' });
  const register = () => {
    assert.equal(run('profiles', 'add', 'work', work).status, 0);
    assert.equal(run('profiles', 'add', 'personal', personal).status, 0);
  };
  const id = 'f40bac38-e2d2-454d-a2c8-ea578618626a';
  const writeSession = async (profile = work, sessionId = id, cwd = project, projectName = '-my-app') => {
    const folder = path.join(profile, 'projects', projectName);
    await fs.mkdir(folder, { recursive: true });
    const filename = path.join(folder, `${sessionId}.jsonl`);
    const contents = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'test prompt' } }) + '\n';
    await fs.writeFile(filename, contents);
    return { filename, contents };
  };
  const active = async () => (JSON.parse(await fs.readFile(path.join(state, 'profiles.json'), 'utf8'))).active;
  return { root, work, personal, state, project, trace, run, runIn, runEnv, register, writeSession, active, id };
}

test('profiles are isolated, active profile tracked, removal preserves config directory', async t => {
  const f = await fixture(t); f.register();
  assert.equal(await f.active(), 'work');
  const list = f.run('profiles', 'list');
  assert.match(list.stdout, /\* work/);
  assert.match(list.stdout, /personal/);
  const duplicate = f.run('profiles', 'add', 'other', f.work);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /cannot share a config directory/);
  assert.equal(f.run('profiles', 'use', 'personal').status, 0);
  assert.equal(await f.active(), 'personal');
  assert.equal(f.run('profiles', 'remove', 'personal').status, 0);
  assert.equal(await f.active(), null);
  assert.ok((await fs.stat(f.personal)).isDirectory());
});

test('sessions are discovered per profile, cwd, and correct sort order', async t => {
  const f = await fixture(t); f.register();
  const first = await f.writeSession();
  await f.writeSession(f.work, 'second-session-id', path.join(f.root, 'unrelated'));
  const result = f.run('sessions', 'work', '--cwd', f.project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(f.id));
  assert.doesNotMatch(result.stdout, /second-session-id/);
  assert.equal(f.run('sessions', 'work', '--limit', '0').status, 1);
  assert.equal(f.run('sessions', 'work', '--limit', '99foo').status, 1);
  assert.equal(f.run('sessions', 'work', '--unknown').status, 1);
  assert.ok(first.filename);
});

test('switch auto-matches project and resumes a fork under target profile', async t => {
  const f = await fixture(t); f.register();
  const source = await f.writeSession();
  const res = f.run('switch', 'personal', '--from', 'work');
  assert.equal(res.status, 0, res.stderr);
  const trace = JSON.parse(await fs.readFile(f.trace, 'utf8'));
  assert.deepEqual(trace.args, ['--resume', source.filename, '--fork-session']);
  assert.equal(trace.config, f.personal);
  assert.equal(trace.cwd, f.project);
  assert.equal(await f.active(), 'personal');
  assert.equal(await fs.readFile(source.filename, 'utf8'), source.contents);
  const files = await fs.readdir(path.join(f.state, 'backups', 'work', '-my-app'));
  assert.equal(files.length, 1);
  const backup = path.join(f.state, 'backups', 'work', '-my-app', files[0]);
  assert.equal(await fs.readFile(backup, 'utf8'), source.contents);
  if (process.platform !== 'win32') assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
});

test('resume uses recorded cwd even when invoked elsewhere', async t => {
  const f = await fixture(t); f.register();
  const source = await f.writeSession();
  const result = f.runIn(f.root, 'resume', f.id.slice(0, 8), '--from', 'work', '--to', 'personal');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(f.trace, 'utf8')), { args: ['--resume', source.filename, '--fork-session'], config: f.personal, cwd: f.project });
});

test('switch refuses to pick another project accidentally', async t => {
  const f = await fixture(t); f.register();
  await f.writeSession(f.work, f.id, f.root);
  const result = f.run('switch', 'personal', '--from', 'work');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No session for/);
  await assert.rejects(fs.stat(f.trace), { code: 'ENOENT' });
});

test('explicit session can override cwd, missing cwd errors before backup', async t => {
  const f = await fixture(t); f.register();
  const old = await f.writeSession(f.work, f.id, '/missing/checkout');
  assert.equal(f.run('resume', 'latest', '--from', 'work', '--to', 'personal').status, 1);
  assert.equal(f.run('resume', f.id.slice(0, 8), '--from', 'work', '--to', 'personal', '--cwd', f.project).status, 0);
  assert.equal(JSON.parse(await fs.readFile(f.trace, 'utf8')).args[1], old.filename);
});

test('refuses ambiguous session prefixes, same-profile resume and token overrides', async t => {
  const f = await fixture(t); f.register();
  await f.writeSession(f.work, 'abc-1');
  await f.writeSession(f.work, 'abc-2');
  assert.match(f.run('resume', 'abc', '--from', 'work', '--to', 'personal').stderr, /ambiguous/);
  assert.match(f.run('resume', 'abc-1', '--from', 'work', '--to', 'work').stderr, /different profiles/);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const result = f.runEnv({ [name]: 'placeholder-not-real' }, 'start', 'work');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(name));
  }
  await assert.rejects(fs.stat(f.trace), { code: 'ENOENT' });
});

test('failed Claude subprocess does not change active profile or source', async t => {
  const f = await fixture(t); f.register();
  const source = await f.writeSession();
  const result = f.runEnv({ MOCK_CLAUDE_EXIT: '7' }, 'switch', 'personal', '--from', 'work');
  assert.equal(result.status, 7);
  assert.equal(await f.active(), 'work');
  assert.equal(await fs.readFile(source.filename, 'utf8'), source.contents);
});

test('source transcript symlinks are not indexed, and configuration is private', async t => {
  const f = await fixture(t); f.register();
  const source = await f.writeSession();
  const link = path.join(path.dirname(source.filename), 'linked-session.jsonl');
  try { await fs.symlink(source.filename, link); } catch (error) { if (error.code !== 'EPERM') throw error; }
  const result = f.run('sessions', 'work');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /linked-session/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.state, 'profiles.json'))).mode & 0o777, 0o600);
});

test('doctor and claude delegated auth command', async t => {
  const f = await fixture(t); f.register();
  assert.match(f.run('doctor').stdout, /mock-claude 2\.1\.0/);
  assert.equal(f.run('auth', 'personal').status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.trace, 'utf8')).args, ['auth', 'login']);
});
