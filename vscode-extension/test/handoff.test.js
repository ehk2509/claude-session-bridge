import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { activate } from '../src/extension.js';
import { PENDING_KEY, createPendingHandoff, validatePendingHandoff } from '../src/handoff.js';

function fakeVSCode(root, answerQueue, { claudeInstalled = true } = {}) {
  const handlers = new Map();
  const messages = [];
  const opened = [];
  const state = new Map();
  const status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const next = () => answerQueue.shift();
  const api = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: () => [] })
    },
    window: {
      createStatusBarItem: () => status,
      showQuickPick: async items => items[0],
      showWarningMessage: async (message) => { messages.push(message); return next(); },
      showInformationMessage: async (message) => { messages.push(message); return next(); },
      showErrorMessage: async message => { messages.push('ERROR ' + message); }
    },
    StatusBarAlignment: { Right: 2 },
    commands: { registerCommand(name, fn) { handlers.set(name, fn); return { dispose() {} }; } },
    extensions: { getExtension: () => claudeInstalled ? {} : undefined },
    env: { openExternal: async uri => { opened.push(uri.url); return true; } },
    Uri: { parse: url => ({ url }) }
  };
  const context = { subscriptions: [], globalState: {
    get: key => state.get(key),
    update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value)
  } };
  return { api, context, handlers, messages, opened, state, status };
}

const session = root => ({ id: 'a1-b2', cwd: root, filename: path.join(root, 'a1-b2.jsonl'),
  bytes: 89, modified: new Date('2026-10-19T09:00:00Z'), title: 'Fix the login bug' });

async function setup(t, answers, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'csbridge-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backup = path.join(root, 'private-backup.jsonl');
  await fs.writeFile(backup, 'test');
  const mock = fakeVSCode(root, answers, options);
  await activate(mock.context, mock.api, {
    listLocalSessions: async () => [session(root)],
    backupLocalSession: async () => backup
  });
  return { ...mock, backup, root };
}

test('pending metadata validates same workspace and rejects invalid shapes', () => {
  const root = path.resolve(os.tmpdir(), 'foo');
  const valid = createPendingHandoff(session(root), path.join(root, 'config'), path.join(root, 'backup'), 123);
  assert.equal(valid.createdAt, 123);
  assert.equal(validatePendingHandoff(valid, [root]).sessionId, 'a1-b2');
  assert.throws(() => validatePendingHandoff(valid, [path.join(root, 'other')]), /same local project/);
  assert.throws(() => validatePendingHandoff({ ...valid, sessionId: '../evil' }, [root]), /invalid/);
});

test('happy path prepares a backup, opens native session, and clears only after visual confirmation', async t => {
  const env = await setup(t, ['Session Is Closed', 'Resume With New Account', 'I Have Signed In', 'History Restored']);
  await env.handlers.get('claudeSessionBridge.handoff')();
  assert.deepEqual(env.opened, ['vscode://anthropic.claude-code/open?session=a1-b2']);
  assert.equal(env.status.visible, false);
  assert.equal(env.state.has(PENDING_KEY), false);
  assert.ok(env.messages.some(m => m.includes('Private backup saved')));
});

test('unfinished handoff survives command completion and can be resumed later', async t => {
  const env = await setup(t, ['Session Is Closed', 'Later', 'I Have Signed In', 'Keep Pending']);
  await env.handlers.get('claudeSessionBridge.handoff')();
  assert.equal(env.status.visible, true);
  assert.equal(env.state.get(PENDING_KEY).backupPath, env.backup);
  await env.handlers.get('claudeSessionBridge.finishHandoff')();
  assert.equal(env.state.has(PENDING_KEY), true);
  assert.deepEqual(env.opened, ['vscode://anthropic.claude-code/open?session=a1-b2']);
});

test('cancelled handoff never opens Claude or creates pending record', async t => {
  const env = await setup(t, [undefined]);
  await env.handlers.get('claudeSessionBridge.handoff')();
  assert.equal(env.state.has(PENDING_KEY), false);
  assert.equal(env.opened.length, 0);
});

test('missing Claude extension prevents handoff from falsely completing', async t => {
  const env = await setup(t, ['Session Is Closed', 'Resume With New Account', 'I Have Signed In'], { claudeInstalled: false });
  await env.handlers.get('claudeSessionBridge.handoff')();
  assert.equal(env.state.has(PENDING_KEY), true);
  assert.equal(env.opened.length, 0);
  assert.ok(env.messages.some(m => m.includes('Install the official')));
});

test('missing backup prevents handoff and keeps pending state', async t => {
  const env = await setup(t, ['Session Is Closed', 'Later']);
  await env.handlers.get('claudeSessionBridge.handoff')();
  await fs.unlink(env.backup);
  await env.handlers.get('claudeSessionBridge.finishHandoff')();
  assert.equal(env.state.has(PENDING_KEY), true);
  assert.equal(env.opened.length, 0);
  assert.ok(env.messages.some(m => m.includes('private transcript backup is missing')));
});
