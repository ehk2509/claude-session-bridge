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
  assert.equal(files.length, 2);
  const snapshot = files.find(name => name.endsWith('.jsonl'));
  assert.ok(snapshot);
  const backup = path.join(f.state, 'backups', 'work', '-my-app', snapshot);
  assert.ok(files.includes(snapshot + '.sha256.json'));
  assert.equal(f.run('verify', backup).status, 0);
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


test('quick requires explicit consent in non-TTY mode; --yes starts a verified pending handoff', async t => {
  const f = await fixture(t); f.register();
  await f.writeSession();
  const rejected = f.run('quick', 'personal', '--from', 'work');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--yes/);
  await assert.rejects(fs.stat(f.trace), { code: 'ENOENT' });
  const ok = f.run('quick', 'personal', '--from', 'work', '--yes');
  assert.equal(ok.status, 0, ok.stderr);
  const state = JSON.parse(await fs.readFile(path.join(f.state, 'pending-handoff.json'), 'utf8'));
  assert.equal(state.source, 'work');
  assert.equal(state.target, 'personal');
  assert.equal(state.sessionId, f.id);
  assert.equal(f.run('pending').status, 0);
  assert.match(f.run('pending').stdout, /backup-integrity: Private backup SHA-256 verified/);
});

test('pending state survives relaunch and requires verified completion', async t => {
  const f = await fixture(t); f.register(); await f.writeSession();
  assert.equal(f.run('switch', 'personal', '--from', 'work').status, 0);
  assert.equal(f.run('switch', 'work', '--from', 'personal').status, 1);
  assert.match(f.run('finish').stderr, /--confirmed/);
  assert.equal(f.run('finish', '--confirmed').status, 0);
  assert.match(f.run('pending').stdout, /No pending handoff/);
  const files = await fs.readdir(path.join(f.state, 'backups', 'work', '-my-app'));
  assert.ok(files.some(name => name.endsWith('.jsonl')));
});

test('tampering a snapshot invalidates verify, pending, retry and finish; no Claude relaunch', async t => {
  const f = await fixture(t); f.register();
  await f.writeSession();
  assert.equal(f.run('quick', 'personal', '--from', 'work', '--yes').status, 0);
  const pending = JSON.parse(await fs.readFile(path.join(f.state, 'pending-handoff.json'), 'utf8'));
  assert.equal(f.run('verify', pending.backup).status, 0);
  await fs.appendFile(pending.backup, 'malicious-data');
  await fs.rm(f.trace);
  assert.equal(f.run('verify', pending.backup).status, 1);
  const diag = f.run('pending');
  assert.equal(diag.status, 1);
  assert.match(diag.stdout, /backup-integrity/);
  assert.equal(diag.stdout.includes('test prompt'), false);
  assert.equal(diag.stdout.includes(f.root), false);
  assert.equal(f.run('retry').status, 1);
  await assert.rejects(fs.stat(f.trace), { code: 'ENOENT' });
  assert.equal(f.run('finish', '--confirmed').status, 1);
  assert.ok((await fs.stat(path.join(f.state, 'pending-handoff.json'))).isFile());
});

test('retry resumes the same snapshot after failed Claude process; no backup duplication', async t => {
  const f = await fixture(t); f.register();
  const original = await f.writeSession();
  const failed = f.runEnv({ MOCK_CLAUDE_EXIT: '7' }, 'switch', 'personal', '--from', 'work');
  assert.equal(failed.status, 7);
  assert.equal(await f.active(), 'work');
  const pending = JSON.parse(await fs.readFile(path.join(f.state, 'pending-handoff.json'), 'utf8'));
  const retry = f.run('retry');
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await f.active(), 'personal');
  const trace = JSON.parse(await fs.readFile(f.trace, 'utf8'));
  assert.deepEqual(trace.args, ['--resume', original.filename, '--fork-session']);
  assert.equal(trace.config, f.personal);
  const after = JSON.parse(await fs.readFile(path.join(f.state, 'pending-handoff.json'), 'utf8'));
  assert.equal(after.backup, pending.backup);
  const files = await fs.readdir(path.dirname(pending.backup));
  assert.equal(files.length, 2);
  assert.equal(f.run('finish', '--confirmed').status, 0);
});

test('an invalid pending record blocks new handoffs rather than being overwritten', async t => {
  const f = await fixture(t); f.register(); await f.writeSession();
  await fs.mkdir(f.state, { recursive: true });
  const pendingFile = path.join(f.state, 'pending-handoff.json');
  await fs.writeFile(pendingFile, '{"version":99,"backup":"/tmp/wrong"}');
  const result = f.run('switch', 'personal', '--from', 'work');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata is invalid/);
  assert.equal(await fs.readFile(pendingFile, 'utf8'), '{"version":99,"backup":"/tmp/wrong"}');
  await assert.rejects(fs.stat(f.trace), { code: 'ENOENT' });
});

test('missing source warns without showing transcript contents; retry requires original source', async t => {
  const f = await fixture(t); f.register();
  const source = await f.writeSession();
  assert.equal(f.run('switch', 'personal', '--from', 'work').status, 0);
  await fs.rm(source.filename);
  const report = f.run('pending');
  assert.equal(report.status, 0);
  assert.match(report.stdout, /source-session/);
  assert.match(report.stdout, /\[WARN\]/);
  assert.equal(report.stdout.includes('test prompt'), false);
  assert.equal(f.run('retry').status, 1);
  assert.match(f.run('retry').stderr, /not safe to retry/);
});

test('verify rejects paths outside the private backup tree', async t => {
  const f = await fixture(t); f.register();
  const session = await f.writeSession();
  const result = f.run('verify', session.filename);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed/);
});

test('CLI executes when launched via npm-style binary symlink', async t => {
  const f = await fixture(t);
  const shim = path.join(f.root, 'csbridge');
  try { await fs.symlink(bin, shim, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlink unavailable on this platform'); return; }
    throw error;
  }
  const result = spawnSync(process.execPath, [shim, 'help'], { encoding: 'utf8', cwd: f.project });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Session Bridge CLI v0\.2\.1/);
  assert.match(result.stdout, /csbridge quick/);
});
