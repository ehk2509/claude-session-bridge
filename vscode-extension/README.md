# Claude Session Bridge for VS Code

A companion to **Anthropic's official Claude Code extension**. Find and safely back up local conversations, then resume one after signing in to a different Claude account — without copying credentials or modifying Claude's transcripts.

> Beta 0.2.0. Requires VS Code 1.94+, Node-powered local or remote extension host, and the official Anthropic Claude Code extension. The cross-account workflow **must be tested with the accounts you use**. If Claude cannot resolve a session ID, its URI handler may open a fresh conversation; the backup is retained for recovery.

## Install from a VSIX

Download the VSIX from the GitHub Actions *VS Code VSIX* artifact, then VS Code → Extensions → `...` → **Install from VSIX...**, or:

```bash
code --install-extension claude-session-bridge-vscode-0.2.0.vsix
```

## Commands (Ctrl+Shift+P / Cmd+Shift+P)

| Command | Behavior |
| --- | --- |
| `Claude Session Bridge: Hand Off Session to Another Account` | Select a local session, make a private backup, guide sign-out/sign-in, then offer to resume |
| `Claude Session Bridge: Finish Pending Handoff` | Resume after authentication, including after a VS Code reload |
| `Claude Session Bridge: Resume Local Session` | Reopen a selected session with Claude's official VS Code URI handler |
| `Claude Session Bridge: Back Up Local Session` | Create a private, byte-for-byte JSONL backup |
| `Claude Session Bridge: Switch Account Guide` | Show official authentication instructions |

### Handoff walk-through

1. Open the **same project root** and finish the currently active Claude conversation. Close the original tab/process.
2. Run **Hand Off Session to Another Account**. Choose the saved conversation from the searchable session picker.
3. The extension snapshots the transcript in your home directory and keeps an optional pending record in VS Code's local extension state.
4. In the **official Claude Code panel**, choose **Settings → Sign out** (or `/logout`), then sign in with the other account.
5. Choose **Resume With New Account** in the bridge dialog, or later run **Finish Pending Handoff** (also available as a status-bar button).
6. Verify previous messages actually appear. Confirm **History Restored** only then; if the panel is blank, select **Keep Pending** and keep the backup.

## Limitations

- The extension **does not automate login, obtain/rotate tokens, transfer usage allowances, or bypass account policies**.
- It **does not copy or rewrite Anthropic's internal session history**. It asks Claude to open the original local session by ID. This works only if Claude can find the session in the current workspace/configuration.
- Different `CLAUDE_CONFIG_DIR` directories, VS Code Remote/WSL/dev containers, or changes in Claude's local transcript format may prevent restoration. A warning appears if the active config directory differs.
- Transcript backups contain potentially sensitive code, prompts, and tool outputs. They are local and never uploaded by this extension; take appropriate precautions with device access and encryption.
- No account identity proof is available through the public VS Code extension API. The user confirms that authentication changed and that the conversation was restored.

This project is not affiliated with Anthropic.

## Developer commands

```bash
cd vscode-extension
npm run check
npm run package:vsix
```

GitHub Actions builds a canonical VSIX with Microsoft's official `@vscode/vsce` packager. Publishing to the Marketplace is a separate step and is **not** automated.
