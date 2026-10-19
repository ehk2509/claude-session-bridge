import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { claudeConfigPath, listLocalSessions, backupLocalSession, sessionLink } from './sessions.js';
import { PENDING_KEY, createPendingHandoff, validatePendingHandoff, configMatches } from './handoff.js';

// Injecting the VS Code API keeps this integration testable without the VS Code host.
export async function activate(context, injectedVscode, services = {}) {
  const imported = injectedVscode ? null : await import('vscode');
  const vscode = injectedVscode || imported.default || imported;
  const listSessions = services.listLocalSessions || listLocalSessions;
  const saveBackup = services.backupLocalSession || backupLocalSession;
  const workspaceDirs = () => (vscode.workspace.workspaceFolders || [])
    .filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath);
  const configDir = () => claudeConfigPath(
    vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'), os.homedir());

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(history) Claude handoff ready';
  status.tooltip = 'Complete the backed-up Claude Code session handoff';
  status.command = 'claudeSessionBridge.finishHandoff';
  context.subscriptions.push(status);
  function updateStatus() {
    if (context.globalState.get(PENDING_KEY)) status.show();
    else status.hide();
  }
  updateStatus();

  async function chooseSession() {
    const workspaces = workspaceDirs();
    if (!workspaces.length) {
      await vscode.window.showWarningMessage('Open a local project folder in VS Code before browsing Claude Code sessions.');
      return null;
    }
    const sessions = await listSessions(configDir(), workspaces);
    if (!sessions.length) {
      await vscode.window.showWarningMessage('No Claude Code conversations found for this workspace. Check Claude Code Session history.');
      return null;
    }
    const chosen = await vscode.window.showQuickPick(sessions.map(s => ({
      label: s.title || s.id,
      description: `${s.modified.toLocaleString()} · ${path.basename(s.cwd)}`,
      detail: `Session ${s.id} · ${formatSize(s.bytes)}`,
      session: s
    })), {
      placeHolder: 'Search and select a Claude Code conversation',
      matchOnDescription: true, matchOnDetail: true
    });
    return chosen?.session || null;
  }

  async function openNativeSession(sessionId, sourceConfig) {
    if (!vscode.extensions.getExtension('anthropic.claude-code')) {
      await vscode.window.showErrorMessage('Install the official Anthropic Claude Code VS Code extension first.');
      return false;
    }
    if (!configMatches(configDir(), sourceConfig)) {
      const action = await vscode.window.showWarningMessage(
        'The active Claude configuration directory differs from the source. Claude Code may not find this session and may open an empty conversation. No session data will be copied or rewritten.',
        { modal: true }, 'Try to Resume'
      );
      if (action !== 'Try to Resume') return false;
    }
    // Official URI protocol; the session must belong to the current VS Code workspace.
    const opened = await vscode.env.openExternal(vscode.Uri.parse(sessionLink(sessionId)));
    if (!opened) {
      await vscode.window.showWarningMessage('Claude Code did not accept the session URL. The backup remains available.');
      return false;
    }
    return true;
  }

  async function prepareHandoff() {
    const selected = await chooseSession();
    if (!selected) return;
    const instruction = await vscode.window.showWarningMessage(
      'Finish the current Claude Code turn and close the original chat before backing up. A running conversation could change during backup.',
      { modal: true }, 'Session Is Closed'
    );
    if (instruction !== 'Session Is Closed') return;
    const existing = context.globalState.get(PENDING_KEY);
    if (existing) {
      const replace = await vscode.window.showWarningMessage(
        'An earlier handoff is pending. Replace it? Its backup will remain on disk.',
        { modal: true }, 'Replace Pending Handoff'
      );
      if (replace !== 'Replace Pending Handoff') return;
    }
    const backupPath = await saveBackup(selected);
    const pending = createPendingHandoff(selected, configDir(), backupPath);
    await context.globalState.update(PENDING_KEY, pending);
    updateStatus();
    const answer = await vscode.window.showInformationMessage(
      `Private backup saved. Now sign out of Claude Code using Settings > Sign out (or /logout), then sign in with your new account. Do not delete ~/.claude. When ready, choose Resume With New Account.`,
      { modal: true }, 'Resume With New Account', 'Later'
    );
    if (answer === 'Resume With New Account') await finishHandoff();
  }

  async function finishHandoff() {
    const pendingRaw = context.globalState.get(PENDING_KEY);
    if (!pendingRaw) {
      await vscode.window.showInformationMessage('No handoff is pending. Run Claude Session Bridge: Hand Off Session first.');
      return;
    }
    const pending = validatePendingHandoff(pendingRaw, workspaceDirs());
    if (!(await fs.stat(pending.backupPath).catch(() => null))?.isFile()) {
      throw new Error('The private transcript backup is missing. Prepare another handoff before resuming.');
    }
    // Do not rely on account detection: Claude owns authentication and exposes no public account-switch API.
    const signedIn = await vscode.window.showInformationMessage(
      'Have you signed out of the original Claude account and signed in to the destination account inside the official Claude Code extension?',
      { modal: true }, 'I Have Signed In'
    );
    if (signedIn !== 'I Have Signed In') return;
    if (!(await openNativeSession(pending.sessionId, pending.sourceConfigDir))) return;
    const confirmed = await vscode.window.showInformationMessage(
      'Check Claude Code: does it display the previous conversation and messages? If it opens a blank chat, keep the pending handoff and use the backup for recovery.',
      { modal: true }, 'History Restored', 'Keep Pending'
    );
    if (confirmed === 'History Restored') {
      await context.globalState.update(PENDING_KEY, undefined);
      updateStatus();
      await vscode.window.showInformationMessage('Session handoff marked complete. The private backup has been kept.');
    }
  }

  async function resume() {
    const selected = await chooseSession();
    if (!selected) return;
    if (await openNativeSession(selected.id, configDir())) {
      await vscode.window.showInformationMessage('Claude Code was asked to open this session. Verify the messages appear before continuing.');
    }
  }

  async function backup() {
    const selected = await chooseSession();
    if (!selected) return;
    const destination = await saveBackup(selected);
    await vscode.window.showInformationMessage(`Private transcript backup saved: ${destination}`);
  }

  function command(name, handler) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await handler(); }
      catch (error) { await vscode.window.showErrorMessage(`Claude Session Bridge: ${error.message}`); }
    }));
  }
  command('claudeSessionBridge.resume', resume);
  command('claudeSessionBridge.backup', backup);
  command('claudeSessionBridge.handoff', prepareHandoff);
  command('claudeSessionBridge.finishHandoff', finishHandoff);
  command('claudeSessionBridge.switchAccount', async () => {
    const choice = await vscode.window.showInformationMessage(
      'To switch Claude accounts, use the official Claude Code Settings > Sign out then sign in. For a safe handoff with backup, use Hand Off Session.',
      'Hand Off Session', 'Open Claude Code'
    );
    if (choice === 'Hand Off Session') await prepareHandoff();
    if (choice === 'Open Claude Code') await vscode.env.openExternal(vscode.Uri.parse('vscode://anthropic.claude-code/open'));
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function deactivate() {}
