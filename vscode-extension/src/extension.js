import os from 'node:os';
import path from 'node:path';
import { claudeConfigPath, listLocalSessions, backupLocalSession, hashLocalFile, sessionLink } from './sessions.js';
import { PENDING_KEY, createPendingHandoff, validatePendingHandoff, configMatches } from './handoff.js';
import { inspectHandoff, formatDiagnosticReport } from './diagnostics.js';

/** VS Code companion; never signs in, modifies Claude auth, or rewrites transcripts. */
export async function activate(context, injectedVscode, services = {}) {
  const imported = injectedVscode ? null : await import('vscode');
  const vscode = injectedVscode || imported.default || imported;
  const listSessions = services.listLocalSessions || listLocalSessions;
  const saveBackup = services.backupLocalSession || backupLocalSession;
  const hashBackup = services.hashLocalFile || hashLocalFile;
  const inspect = services.inspectHandoff || inspectHandoff;
  const workspaceDirs = () => (vscode.workspace.workspaceFolders || [])
    .filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  const configDir = () => claudeConfigPath(
    vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'), os.homedir());
  const claudeInstalled = () => Boolean(vscode.extensions.getExtension('anthropic.claude-code'));
  const pendingRecord = () => context.globalState.get(PENDING_KEY);
  const output = vscode.window.createOutputChannel?.('Claude Session Bridge');
  if (output) context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);
  function updateStatus() {
    const pending = pendingRecord();
    status.text = pending ? '$(history) Finish Claude handoff' : '$(arrow-left-right) Claude handoff';
    status.tooltip = pending ? 'Finish the saved cross-account handoff' : 'Back up and switch your Claude Code session';
    status.command = pending ? 'claudeSessionBridge.finishHandoff' : 'claudeSessionBridge.quickHandoff';
    status.show();
  }
  updateStatus();

  async function availableSessions() {
    const folders = workspaceDirs();
    if (!folders.length) {
      await vscode.window.showWarningMessage('Open a local project folder in VS Code before browsing Claude Code sessions.');
      return null;
    }
    const sessions = await listSessions(configDir(), folders);
    if (!sessions.length) {
      await vscode.window.showWarningMessage('No Claude Code conversations found for this workspace. Check Claude Code Session history.');
      return null;
    }
    return sessions;
  }

  async function sessionPicker(sessions) {
    const chosen = await vscode.window.showQuickPick(sessions.map(s => ({
      label: s.title || s.id,
      description: `${s.modified.toLocaleString()} · ${path.basename(s.cwd)}`,
      detail: `Session ${s.id} · ${formatSize(s.bytes)}`,
      session: s
    })), { placeHolder: 'Search and select a Claude Code conversation', matchOnDescription: true, matchOnDetail: true });
    return chosen?.session || null;
  }

  async function chooseSession() {
    const sessions = await availableSessions();
    return sessions && sessionPicker(sessions);
  }

  /** Recent means newest transcript write, not an authenticated active-session ID. */
  async function chooseRecentSession() {
    const sessions = await availableSessions();
    if (!sessions) return null;
    if (workspaceDirs().length !== 1) return sessionPicker(sessions); // Never guess across workspace roots.
    const recent = sessions[0];
    const choice = await vscode.window.showInformationMessage(
      `Most recently saved conversation: ${recent.title || recent.id} (${recent.modified.toLocaleString()}). ` +
      'This may not be the currently open Claude Code chat. Confirm before backing up.',
      { modal: true }, 'Use Most Recent', 'Choose Session'
    );
    if (choice === 'Use Most Recent') return recent;
    if (choice === 'Choose Session') return sessionPicker(sessions);
    return null;
  }

  async function diagnose({ show = true } = {}) {
    const result = await inspect({
      pending: pendingRecord(), workspaces: workspaceDirs(), configDir: configDir(),
      claudeInstalled: claudeInstalled(), digest: hashBackup
    });
    if (show) {
      const report = formatDiagnosticReport(result, {
        remote: Boolean(vscode.env.remoteName), version: '0.3.0'
      });
      output?.clear();
      output?.appendLine(report);
      output?.show(true);
      if (!output) await vscode.window.showInformationMessage(report);
    }
    return result;
  }

  async function openNativeSession(id, sourceConfig) {
    if (!claudeInstalled()) {
      await vscode.window.showErrorMessage('Install the official Anthropic Claude Code VS Code extension first.');
      return false;
    }
    if (!configMatches(configDir(), sourceConfig)) {
      const action = await vscode.window.showWarningMessage(
        'The active Claude configuration directory differs from the source. Claude Code may open an empty chat. No data will be copied or rewritten.',
        { modal: true }, 'Try to Resume'
      );
      if (action !== 'Try to Resume') return false;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(sessionLink(id)));
    if (!opened) {
      await vscode.window.showWarningMessage('Claude Code did not accept the session URL. The private backup remains available.');
      return false;
    }
    return true;
  }

  async function prepareHandoff(selected) {
    if (!selected) return;
    const closed = await vscode.window.showWarningMessage(
      'Finish the Claude Code turn and close the original chat before backing up. A running conversation may change during backup.',
      { modal: true }, 'Session Is Closed'
    );
    if (closed !== 'Session Is Closed') return;
    if (pendingRecord()) {
      const replace = await vscode.window.showWarningMessage(
        'A handoff is already pending. Replace it? The earlier private backup will remain on disk.',
        { modal: true }, 'Replace Pending Handoff'
      );
      if (replace !== 'Replace Pending Handoff') return;
    }
    // A failed backup or hash leaves the previous pending record untouched.
    const backupPath = await saveBackup(selected);
    const backupSha256 = await hashBackup(backupPath);
    const pending = createPendingHandoff(selected, configDir(), backupPath, Date.now(), backupSha256);
    await context.globalState.update(PENDING_KEY, pending);
    updateStatus();
    const action = await vscode.window.showInformationMessage(
      'Private backup verified. Sign out from the official Claude Code panel and sign in with the destination account. ' +
      'Keep ~/.claude intact. After sign-in, use Finish Pending Handoff.',
      { modal: true }, 'Resume With New Account', 'Later'
    );
    if (action === 'Resume With New Account') await finishHandoff();
  }

  async function finishHandoff() {
    const raw = pendingRecord();
    if (!raw) {
      await vscode.window.showInformationMessage('No handoff is pending. Use Claude Session Bridge: Quick Account Handoff.');
      return;
    }
    const pending = validatePendingHandoff(raw, workspaceDirs());
    const health = await diagnose({ show: false });
    if (health.status === 'blocked') {
      await diagnose();
      await vscode.window.showWarningMessage('Handoff cannot continue safely. Check Claude Session Bridge diagnostics; the pending record was preserved.');
      return;
    }
    const signedIn = await vscode.window.showInformationMessage(
      'Have you signed in with the destination account inside the official Claude Code extension?',
      { modal: true }, 'I Have Signed In'
    );
    if (signedIn !== 'I Have Signed In') return;
    if (!(await openNativeSession(pending.sessionId, pending.sourceConfigDir))) return;
    const restored = await vscode.window.showInformationMessage(
      'Verify Claude Code displays your previous messages and understands the ongoing task. ' +
      'If the conversation is empty, keep this handoff pending.',
      { modal: true }, 'History Restored', 'Keep Pending', 'Show Diagnostics'
    );
    if (restored === 'Show Diagnostics') await diagnose();
    if (restored === 'History Restored') {
      await context.globalState.update(PENDING_KEY, undefined);
      updateStatus();
      await vscode.window.showInformationMessage('Session handoff confirmed. Your private backup was retained.');
    }
  }

  async function resume() {
    const selected = await chooseSession();
    if (!selected) return;
    if (await openNativeSession(selected.id, configDir())) {
      await vscode.window.showInformationMessage('Claude Code was asked to open this conversation. Verify previous messages appear.');
    }
  }

  async function backup() {
    const selected = await chooseSession();
    if (!selected) return;
    const destination = await saveBackup(selected);
    await vscode.window.showInformationMessage(`Private transcript backup saved: ${destination}`);
  }

  function command(name, fn) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await fn(); }
      catch (err) { await vscode.window.showErrorMessage(`Claude Session Bridge: ${err.message}`); }
    }));
  }
  command('claudeSessionBridge.quickHandoff', async () => prepareHandoff(await chooseRecentSession()));
  command('claudeSessionBridge.handoff', async () => prepareHandoff(await chooseSession()));
  command('claudeSessionBridge.finishHandoff', finishHandoff);
  command('claudeSessionBridge.diagnose', diagnose);
  command('claudeSessionBridge.resume', resume);
  command('claudeSessionBridge.backup', backup);
  command('claudeSessionBridge.switchAccount', async () => {
    const choice = await vscode.window.showInformationMessage(
      'Switch accounts in the official Claude Code Settings → Sign out, then sign in. ' +
      'For a protected handoff, begin Quick Account Handoff first.',
      'Quick Account Handoff', 'Open Claude Code'
    );
    if (choice === 'Quick Account Handoff') await prepareHandoff(await chooseRecentSession());
    if (choice === 'Open Claude Code') await vscode.env.openExternal(vscode.Uri.parse('vscode://anthropic.claude-code/open'));
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function deactivate() {}
