// Account authentication is deliberately not automated: Claude Code owns it.
// Pending handoff records metadata only, never transcript contents or credentials.
import path from 'node:path';

export const PENDING_KEY = 'pendingHandoffV1';

export function createPendingHandoff(session, configDir, backupPath, now = Date.now(), backupSha256 = null) {
  if (!session || !session.id || !session.cwd || !session.filename || !backupPath) {
    throw new Error('A local session and successful backup are required');
  }
  return {
    version: 1, sessionId: session.id, cwd: path.resolve(session.cwd),
    sourceFile: session.filename, sourceConfigDir: path.resolve(configDir),
    backupPath, createdAt: now, ...(backupSha256 ? { backupSha256 } : {})
  };
}

export function validatePendingHandoff(value, workspaceFolders) {
  if (!value || value.version !== 1 || typeof value.sessionId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) ||
      typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
      typeof value.sourceConfigDir !== 'string' || !path.isAbsolute(value.sourceConfigDir) ||
      typeof value.sourceFile !== 'string' || !path.isAbsolute(value.sourceFile) ||
      typeof value.backupPath !== 'string' || !path.isAbsolute(value.backupPath) ||
      (value.backupSha256 != null && !/^[a-f0-9]{64}$/.test(value.backupSha256))) {
    throw new Error('Pending handoff metadata is invalid; prepare another handoff.');
  }
  if (!(workspaceFolders || []).some(folder => equalPath(folder, value.cwd))) {
    throw new Error('Open the same local project folder used by the original session before resuming.');
  }
  return value;
}

function equalPath(a, b) {
  if (!a || !b) return false;
  const normalize = p => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export function configMatches(a, b) { return equalPath(a, b); }
