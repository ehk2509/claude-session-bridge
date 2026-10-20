# Claude Session Bridge for VS Code

<img src="media/icon.png" alt="Claude Session Bridge logo" width="144" />

Companion extension for the official Anthropic Claude Code extension. Safely back up local sessions and reopen them after signing into another Claude account. **Your transcript files and credentials are never copied to an external service.**

**v0.3.0** — Requires VS Code 1.94+, local or remote Node.js extension host, and `anthropic.claude-code`. Not affiliated with Anthropic. No Marketplace publication yet.

## Install

1. Download `claude-session-bridge-vscode-0.3.0.vsix` from the [v0.3.0 GitHub beta release](https://github.com/ehk2509/claude-session-bridge/releases/tag/v0.3.0), or from a successful [CI artifact](https://github.com/ehk2509/claude-session-bridge/actions) before the release is available.
2. In VS Code choose Extensions → `...` → **Install from VSIX...**.
3. Open the **exact project root** used by the previous Claude Code conversation.

Or install locally with `code --install-extension claude-session-bridge-vscode-0.3.0.vsix`.

## Find the status-bar shortcut

The **VS Code status bar** is the thin strip at the bottom of the editor window, usually with **Claude handoff** on the right. Click it to start the suggested-session workflow. During an unfinished handoff, it changes to **Finish Claude handoff**.

If the bar is hidden, use **View → Appearance → Status Bar**. If the shortcut still is not visible, check that v0.3.0 is installed and enabled, run **Developer: Reload Window**, or use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) to start **Claude Session Bridge: Quick Account Handoff** instead. The status-bar shortcut is optional; the command is equivalent.

## Fast handoff

1. Finish the current Claude Code turn and **close that chat**. Open `Ctrl+Shift+P` / `Cmd+Shift+P` → **Claude Session Bridge: Quick Account Handoff**, or click the **Claude handoff** status-bar item.
2. Bridge proposes the *most recently saved* conversation in the current project. **Confirm it is the correct conversation**, or choose **Choose Session** to browse the searchable local history. The timestamp is a heuristic; Bridge cannot see Claude's active chat ID through the public VS Code API.
3. Confirm that the original chat is closed. Bridge makes a private, byte-for-byte backup and records its SHA-256 digest locally.
4. In the official Claude Code panel use **Settings → Sign out** (or `/logout` if available) and sign into your second account. **Do not delete `~/.claude`.**
5. Use **Finish Pending Handoff** (or the status-bar item), confirm you signed in, and let Bridge request that Claude Code reopen the saved session by ID.
6. Check that earlier messages appear **and** Claude can continue the previous task. Click **History Restored** only if confirmed. Otherwise choose **Keep Pending** and use **Diagnose Session Recovery**.

The saved handoff survives a VS Code reload. The private backup is retained even after successful confirmation.

## Commands

| Command (all prefixed `Claude Session Bridge:`) | Purpose |
| --- | --- |
| **Quick Account Handoff** | Suggest the latest local conversation, confirm, back up, guide sign-in and reopen |
| **Hand Off Session to Another Account** | Start from an explicit searchable session picker |
| **Finish Pending Handoff** | Continue after sign-in or a VS Code reload |
| **Diagnose Session Recovery** | Check project, config, Claude Code installation, transcript/backup existence, and backup SHA-256 |
| **Resume Local Session** | Ask Claude Code to reopen a selected session under the currently authenticated account |
| **Back Up Local Session** | Save a private transcript backup without switching accounts |
| **Switch Account Guide** | Show manual official Claude Code account-switching instructions |

## Diagnostics and troubleshooting

Run `Claude Session Bridge: Diagnose Session Recovery` and inspect the **Claude Session Bridge** output channel. It shows safe operational statuses without prompt text, transcript contents, full local paths, tokens, or raw SHA-256 values. Checks include missing Claude Code extension, nonmatching project, changed configuration directory, missing source transcript, missing private backup, and failed backup-integrity verification.

If Claude Code itself exits with code 1 and says you must accept updated terms, launch its official CLI, review and accept the terms, then reload VS Code. The bridge doesn't automate acceptance or bypass sign-in. If Claude cannot reopen the original conversation, keep the pending record and backup instead of claiming success.

## Limits and security

- **No automatic sign-in or account change.** Authentication belongs to Claude Code; the user signs out/in manually.
- **No guaranteed active-chat detection.** Latest saved transcript is a *suggestion* only, not the live tab's verified session ID.
- **No automatic login-event listener or passive backup of all conversations.** A backup runs only when the user initiates a handoff or chooses Back Up.
- **No transcript rewrite or automatic restore into Claude's private storage.** Claude Code must still resolve the local session in the selected workspace/configuration. Its native URI handler can open a blank chat if it cannot.
- A different `CLAUDE_CONFIG_DIR`, remote/WSL/container environment, project path, or Claude Code update may prevent a resume. Diagnostics reports these risks.
- Backup transcripts are **sensitive local files** (code, tool outputs, prompts). Store them on an encrypted device and never attach them to public issues.
- The tool does not transfer account entitlements, quotas, tokens, MCP credentials, or private server-side context. Previously compacted context remains summarized, not magically expanded.

## Development

```bash
npm --prefix vscode-extension run check
npm --prefix vscode-extension run package:vsix
```

`@vscode/vsce` builds the VSIX with a version-independent filename. The GitHub Actions artifact contains the installable extension, which is not automatically Marketplace-published.

Marketplace publication follows the Codico-style GitHub Actions `VSCE_PAT` secret workflow, and is **manual, not automatic**. See the [publisher and Actions-secret setup guide](../docs/marketplace.md).
