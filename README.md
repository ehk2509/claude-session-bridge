# Claude Session Bridge

<img src="vscode-extension/media/icon.png" alt="Claude Session Bridge logo" width="160" />

**Continue a Claude Code conversation after switching Claude accounts — directly inside VS Code.**

Marketplace publisher: **`ElyesHkiri`** · Extension ID: `ElyesHkiri.claude-session-bridge-vscode`.

Claude Session Bridge is an open-source, local-first companion for the official **Anthropic Claude Code** extension. It discovers saved conversations for the current workspace, makes a private backup, guides you through signing in to your other account, and asks Claude Code to reopen the same session.

> **VS Code extension: v0.3.2 (beta)** · **CLI: v0.1.0 (beta)**
>
> Tested successfully by one user on Linux with two Claude accounts: the previous conversation appeared and Claude continued its earlier task. This does **not** guarantee every account, platform, remote environment, or Claude Code version will support the same handoff.

No credential copying, token rotation, telemetry, cloud synchronization, or automatic account switching. This project is **not affiliated with or endorsed by Anthropic**.

## VS Code: install v0.3.2

You need:

- VS Code **1.94+** with a Node-capable extension host.
- Anthropic's **official Claude Code** extension (`anthropic.claude-code`), installed and signed in.
- The same local project folder that was used for the original conversation.
- The installable `claude-session-bridge-vscode-0.3.2.vsix` from the [v0.3.2 GitHub Release](https://github.com/ehk2509/claude-session-bridge/releases/tag/v0.3.2). A CI artifact is also available before the release is published. This is **not yet a Marketplace listing**.

Install through **Extensions** (`Ctrl+Shift+X`) → `...` → **Install from VSIX...**, or:

```bash
code --install-extension claude-session-bridge-vscode-0.3.2.vsix
```

Reload VS Code after upgrading. Open the exact project root in which your previous Claude Code session ran.

## Quick account handoff in VS Code

1. **Finish the current Claude response and close the original Claude chat.** The extension cannot take a consistent backup from an actively changing transcript.
2. Click **Claude handoff** in the status bar, or run `Claude Session Bridge: Quick Account Handoff` from the Command Palette (`Ctrl+Shift+P`; macOS `Cmd+Shift+P`).
3. **Verify the suggested conversation.** The suggestion is the *most recently written* saved session in the current workspace, **not** a verified active-chat ID. Choose **Use Most Recent** only if it is correct, otherwise choose **Choose Session**.
4. Confirm **Session Is Closed**. Claude Session Bridge saves a **local, byte-for-byte backup** and records its **SHA-256 digest**. Select **Later** to switch accounts.
5. In the **official Claude Code panel**, choose **Settings → Sign out** (or `/logout` when supported), then sign in with the other account. **Do not delete `~/.claude`.**
6. Click **Finish Claude handoff** in the status bar, or run `Claude Session Bridge: Finish Pending Handoff`. Confirm that the destination account is signed in. The bridge asks Claude Code to reopen the stored session by ID.
7. Confirm that **earlier messages are visible and Claude can continue the previous task**. Choose **History Restored** only then. Otherwise choose **Keep Pending** and run diagnostics.

**Important:** The tool does not sign out or sign in for you. It does not rewrite session files or insert a backup into Claude Code's private storage. Claude Code must be able to resolve the saved session under the current project and configuration.

### Where is the VS Code status bar?

The status bar is the **thin strip along the very bottom of the VS Code window**. Look for **Claude handoff** or **Finish Claude handoff**, normally near the bottom right. The item changes according to whether a handoff is pending.

If it is missing:

1. Enable **View → Appearance → Status Bar**.
2. Make sure **Claude Session Bridge v0.3.2** is installed and enabled in Extensions.
3. Run **Developer: Reload Window** from the Command Palette.
4. Use `Ctrl+Shift+P` → `Claude Session Bridge: Quick Account Handoff` even if the status-bar item is hidden.

## VS Code commands

Run these from the Command Palette (all names start with `Claude Session Bridge:`):

| Command | Purpose |
| --- | --- |
| **Quick Account Handoff** | Suggest the latest saved project conversation, confirm, back up and begin a guided handoff |
| **Hand Off Session to Another Account** | Choose an explicit conversation from searchable local history |
| **Finish Pending Handoff** | Reopen a saved session after changing account, including after reloading VS Code |
| **Diagnose Session Recovery** | Check workspace/config mismatch, Claude extension, source transcript, backup and SHA-256 integrity |
| **Resume Local Session** | Ask Claude Code to reopen an existing local conversation using the current account |
| **Back Up Local Session** | Take a private snapshot without switching accounts |
| **Switch Account Guide** | Show official sign-out/sign-in instructions |

Handoffs survive a VS Code window reload. A successful handoff **keeps its private backup** instead of deleting it. Diagnostic reports avoid transcript content, full local paths, credentials and digest values.

## Troubleshooting

**No conversations found.** Open the *same* project root as the original conversation. Confirm that the Claude Code extension uses the same local session/config directory. Changing `CLAUDE_CONFIG_DIR`, moving a project checkout, or working through WSL, SSH or a dev container can affect discovery.

**An empty chat opens after switching.** Don't click **History Restored**. Choose **Keep Pending**, run `Claude Session Bridge: Diagnose Session Recovery`, and check the **Claude Session Bridge** output channel. Opening a session URI does not guarantee Claude Code recovered its messages.

**Claude Code exits with code 1 or requests Terms and Privacy Policy acceptance.** Review and accept the updated terms using Claude Code's **official terminal CLI**, then reload VS Code. If `claude` is not found in your terminal, install the official Claude Code CLI first (see Anthropic's [setup guide](https://code.claude.com/docs/en/setup)). The bridge does not accept terms for you.

**Integrity check failed.** Keep the pending record. Do not trust or delete an altered backup. Create a new handoff only after ensuring the source session is closed; never attach transcript backups to public GitHub issues.

**Old conversations were compacted.** Claude Code may retain a *summary* of earlier turns after context compaction. The bridge cannot restore discarded model context or guarantee all historic tool calls are accessible to the model.

## Optional terminal CLI (v0.1.0)

Use the CLI if you work in a terminal or intentionally manage **separate Claude configuration directories** for multiple accounts. It operates independently from the native VS Code chat-panel handoff.

Requirements: Node.js **20+**, Claude Code CLI on your `PATH`, and account profiles already authenticated in their respective config directories.

```bash
git clone https://github.com/ehk2509/claude-session-bridge.git
cd claude-session-bridge
npm ci
npm link

csbridge profiles add work ~/.claude
csbridge profiles add personal ~/.claude-personal
csbridge auth personal

cd /path/to/my-project
csbridge sessions work
# Finish and close the source Claude session first.
csbridge switch personal --from work
```

The CLI creates a private transcript backup, then delegates resumption to Claude Code using `--resume <absolute-transcript-path> --fork-session` with the destination account's `CLAUDE_CONFIG_DIR`. Unlike the VS Code UI workflow, **this runs Claude Code in a terminal**. You can also use `csbridge doctor`, `csbridge backup latest --from work`, and `csbridge resume <session-id> --from work --to personal`.

The root npm package remains **private** and versioned `0.1.0`; do not confuse that version with the `v0.3.2` VS Code extension.

## Security and limitations

- All work happens locally. **Backups contain sensitive prompts, code, paths and tool outputs**: keep them private and protect your disk.
- Claude Code's authentication, permissions, plan limits and sign-in are always managed by Claude Code.
- No automatic live-process transfer, background account rotation, token exchange, session-format rewrite or quota bypass.
- The VS Code extension cannot reliably determine the *active* Claude chat using a public extension API. Recent-session selection always needs confirmation.
- Native restoration depends on Claude Code resolving the original session ID in the current workspace and configuration. Different config directories and remote environments are not guaranteed to work.
- Worktree state, skills, MCP configuration, permissions and server-side memories do not automatically transfer just because a conversation reopens.

## Development and validation

```bash
npm ci
npm run check
npm --prefix vscode-extension run check
npm --prefix vscode-extension run package:vsix
```

CI tests Node **20/22/24** on **Linux/macOS/Windows** and packages a downloadable VSIX. Tests validate local session discovery, profile isolation, backups, handoff recovery, diagnostics and safe invocation. Automated mocks do **not** replace real two-account VS Code smoke testing.

- [VS Code companion documentation](vscode-extension/README.md)
- [Changelog](CHANGELOG.md)
- [GitHub beta release](https://github.com/ehk2509/claude-session-bridge/releases/tag/v0.3.2)
- [Marketplace publication checklist](docs/marketplace.md)
- [Claude Code VS Code documentation](https://code.claude.com/docs/en/vs-code)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

MIT licensed.