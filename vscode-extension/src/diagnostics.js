/** Local-only checks. This module never reads credential files or sends telemetry. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { configMatches } from './handoff.js';

export async function inspectHandoff({ pending = null, workspaces = [], configDir, claudeInstalled = false, stat = fs.lstat, digest = null }) {
  const checks = [];
  const add = (code, status, message) => checks.push({ code, status, message });

  add('claude-extension', claudeInstalled ? 'pass' : 'fail', claudeInstalled
    ? 'Official Claude Code VS Code extension is installed.'
    : 'Official Claude Code extension not detected; install anthropic.claude-code.');
  add('workspace', workspaces.length ? 'pass' : 'fail', workspaces.length
    ? 'A local workspace is open.' : 'Open the original local project folder.');
  if (!pending) {
    add('pending-handoff', 'info', 'No pending handoff. Start a new handoff to create a private backup.');
  } else {
    if (typeof pending.cwd !== 'string' || !path.isAbsolute(pending.cwd) ||
        typeof pending.sourceConfigDir !== 'string' || !path.isAbsolute(pending.sourceConfigDir) ||
        typeof pending.backupPath !== 'string' || !path.isAbsolute(pending.backupPath) ||
        typeof pending.sourceFile !== 'string' || !path.isAbsolute(pending.sourceFile)) {
      add('pending-metadata', 'fail', 'Saved handoff metadata is invalid. Start a new handoff; never paste private session data into a bug report.');
      return { status: 'blocked', checks };
    }
    const matches = workspaces.some(folder => configMatches(folder, pending.cwd));
    add('project-match', matches ? 'pass' : 'fail', matches
      ? 'Open project matches the saved handoff.' : 'Open the exact original project folder before resuming.');
    const sameConfig = configMatches(configDir, pending.sourceConfigDir);
    add('config-match', sameConfig ? 'pass' : 'warn', sameConfig
      ? 'Source and current Claude config directories match.'
      : 'CLAUDE_CONFIG_DIR differs. Claude Code may not see this session.');
    for (const [code, filename] of [['backup', pending.backupPath], ['source-transcript', pending.sourceFile]]) {
      let existing = false;
      try { existing = (await stat(filename)).isFile(); } catch { /* absent or inaccessible */ }
      add(code, existing ? 'pass' : code === 'backup' ? 'fail' : 'warn', existing
        ? `${code === 'backup' ? 'Private backup' : 'Original transcript'} is present.`
        : code === 'backup' ? 'Private backup is missing or inaccessible.'
          : 'Original transcript missing; Claude Code may not be able to reopen this session. The backup is not rewritten automatically.');
      if (code === 'backup' && existing && pending.backupSha256 && digest) {
        let matchesHash = false;
        try { matchesHash = await digest(filename) === pending.backupSha256; } catch { /* unreadable */ }
        add('backup-integrity', matchesHash ? 'pass' : 'fail', matchesHash
          ? 'Private backup SHA-256 matches the handoff snapshot.'
          : 'Private backup SHA-256 mismatch; do not rely on this snapshot.');
      }
    }
  }
  return {
    status: checks.some(check => check.status === 'fail') ? 'blocked'
      : checks.some(check => check.status === 'warn') ? 'warning' : 'ready',
    checks
  };
}

/** Safe to copy into issue reports: no paths, prompt text, transcript data, or tokens. */
export function formatDiagnosticReport(result, { version = '0.3.0', remote = false } = {}) {
  const lines = [`Claude Session Bridge ${version} — local diagnostic summary`, `Environment: ${process.platform} / Node ${process.versions.node}`, `VS Code remote: ${remote ? 'yes' : 'no'}`, `Overall: ${result.status}`];
  for (const check of result.checks) lines.push(`[${check.status.toUpperCase()}] ${check.code}: ${check.message}`);
  lines.push('No credentials were accessed. Conversation text is not included; backup integrity is checked with a local SHA-256 digest.');
  return lines.join('\n');
}
