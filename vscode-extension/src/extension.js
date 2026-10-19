import os from 'node:os';
import path from 'node:path';
import { claudeConfigPath, listLocalSessions, backupLocalSession, sessionLink } from './sessions.js';

// VS Code is loaded dynamically so the data handling can be tested without the IDE.
export async function activate(context) {
  const vscode = await import('vscode');
  const workspaceDirs = () => (vscode.workspace.workspaceFolders || [])
    .filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath);
  const configDir = () => claudeConfigPath(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'), os.homedir());

  async function chooseSession() {
    const workspaces = workspaceDirs();
    if (!workspaces.length) {
      await vscode.window.showWarningMessage('Open a local project folder in VS Code to browse its Claude Code sessions.');
      return null;
    }
    const sessions = await listLocalSessions(configDir(), workspaces);
    if (!sessions.length) {
      await vscode.window.showWarningMessage('No local Claude Code transcripts found for this workspace and configuration. Check the Session history button in Claude Code.');
      return null;
    }
    const choice = await vscode.window.showQuickPick(sessions.map(s => ({
      label: s.id,
      description: `${s.modified.toLocaleString()} · ${path.basename(s.cwd)}`,
      detail: s.cwd,
      session: s
    })), { placeHolder: 'Select a saved Claude Code conversation', matchOnDescription: true, matchOnDetail: true });
    return choice?.session || null;
  }

  context.subscriptions.push(vscode.commands.registerCommand('claudeSessionBridge.resume', async () => {
    try {
      const selected = await chooseSession();
      if (!selected) return;
      // Claude only supports the current workspace via this URL scheme; never pass file:// transcripts or credentials.
      const url = sessionLink(selected.id);
      await vscode.env.openExternal(vscode.Uri.parse(url));
      // The Claude URI handler may start a *new* conversation if its session lookup fails.
      void vscode.window.showInformationMessage('Session requested. Confirm your previous messages appear before continuing; Claude may open a new conversation if the ID is not found.');
    } catch (error) { await vscode.window.showErrorMessage(`Unable to open session: ${error.message}`); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('claudeSessionBridge.backup', async () => {
    try {
      const selected = await chooseSession();
      if (!selected) return;
      const destination = await backupLocalSession(selected);
      await vscode.window.showInformationMessage(`Private transcript backup saved: ${destination}`);
    } catch (error) { await vscode.window.showErrorMessage(`Session backup failed: ${error.message}`); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('claudeSessionBridge.switchAccount', async () => {
    const answer = await vscode.window.showInformationMessage(
      'To switch Claude accounts without losing local sessions: finish/close the running session, back it up, then use /logout and /login in Claude Code. Keep the same Claude configuration folder. Session history is stored locally.',
      'Back Up a Session', 'Open Claude Code'
    );
    if (answer === 'Back Up a Session') return vscode.commands.executeCommand('claudeSessionBridge.backup');
    if (answer === 'Open Claude Code') return vscode.env.openExternal(vscode.Uri.parse('vscode://anthropic.claude-code/open'));
  }));
}

export function deactivate() {}
