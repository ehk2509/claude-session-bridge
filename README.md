# Claude Session Bridge

> **VS Code companion v0.3.0:** Click the *Claude handoff* status-bar item or run `Claude Session Bridge: Quick Account Handoff` to suggest the latest saved conversation, back it up, sign in manually with the other account, and resume. Use `Claude Session Bridge: Diagnose Session Recovery` if resumption fails. See [VS Code extension documentation](vscode-extension/README.md) and [changelog](CHANGELOG.md).


**Keep your Claude Code conversation when you change accounts.** `csbridge` is a local-first, dependency-free Node.js CLI that discovers Claude Code transcripts, creates private backups, and opens a **fork of an existing session** with a different, independently authenticated Claude Code configuration directory.

> **v0.1.0 — beta / proof-of-concept.** CLI behavior is covered by automated tests using a mocked Claude executable. Cross-account resumption has **not yet been validated against two real Claude accounts**. Claude Code may change how it reads external session paths. Do not depend on this for mission-critical conversation state without testing it on your installation.

No credential-copying. No login automation. No token rotation. No telemetry. No runtime dependencies.

## Requirements

- Node.js 20 or newer
- Claude Code CLI on your PATH (`claude --version`)
- Two Claude Code account profiles with **separate configuration directories**, authenticated by Claude Code itself
- Linux/macOS recommended; Windows is included in the automated CI matrix but cross-account smoke testing is pending

## Install from GitHub

```bash
git clone https://github.com/ehk2509/claude-session-bridge.git
cd claude-session-bridge
npm ci
npm link
csbridge doctor
```

This version is intentionally marked `private: true` to prevent accidental publication to npm before release validation.

## Quick start

```bash
# Register the existing/default account and a separate account.
csbridge profiles add work ~/.claude
csbridge profiles add personal ~/.claude-personal

# Claude Code, not this tool, handles sign-in for each profile.
csbridge auth personal

# Inspect sessions and confirm the correct project.
csbridge sessions work
cd /path/to/my-project

# Close the original Claude session after its current turn finishes.
# Then reopen its most recently modified conversation here, under personal.
csbridge switch personal --from work
```

The command creates a private snapshot of the source `.jsonl` transcript and launches:

```bash
CLAUDE_CONFIG_DIR=/path/to/personal claude \
  --resume /absolute/path/to/original-session.jsonl --fork-session
```

That uses Claude Code's official CLI flags. `--fork-session` leaves the original session available for future resumption instead of writing both accounts' turns to the same transcript.

### Common commands

| Command | Purpose |
| --- | --- |
| `csbridge profiles add work ~/.claude` | Register a profile and its config directory |
| `csbridge profiles list` | Display registered profiles and the active bridge profile |
| `csbridge profiles use work` | Set the bridge's default source profile |
| `csbridge profiles remove work` | Unregister a profile **without deleting any files** |
| `csbridge auth personal` | Run `claude auth login` under that profile |
| `csbridge start personal` | Start a fresh Claude Code session under that profile |
| `csbridge sessions work --cwd "$PWD"` | Discover source sessions for a project |
| `csbridge switch personal --from work` | Fork the latest recorded session in the current project to personal |
| `csbridge resume abcd1234 --from work --to personal` | Fork a specific existing conversation by unique ID prefix |
| `csbridge resume latest --from work --to personal` | Fork the latest transcript **across all projects** |
| `csbridge backup latest --from work` | Privately snapshot a transcript without starting Claude |
| `csbridge doctor` | Check CLI availability, profile paths and inherited auth conflicts |

If you've previously selected an active bridge profile with `profiles use`, `switch <target>` can infer `--from` when that active profile differs from the target. If no source is selected, it searches other registered profiles for a matching project. The target profile becomes the bridge's active profile after Claude exits successfully.

For a project checkout that moved, pass `--cwd /new/path` to an **explicit** `resume <id>` or `switch --session <id>` command. Automatic `switch` requires a matching original project path to avoid opening an unrelated conversation.

### How it works

1. Register each account's `CLAUDE_CONFIG_DIR`. These directories are never combined, and a single directory cannot be assigned to multiple account names.
2. Scan each profile's `projects/*/*.jsonl` session transcripts without modifying their contents. Read only a bounded prefix to find Claude Code's recorded working directory (when present).
3. Choose a specific session by ID/prefix or select the newest session associated with the current project.
4. Snapshot the source transcript into `~/.config/claude-session-bridge/backups/`. On Unix, the file is owner-readable only (`0600`).
5. Start Claude Code under the destination configuration using `--resume <absolute path> --fork-session`.

The CLI never opens or copies `.credentials.json`, OAuth secrets, API keys, or other Claude authentication data. If environment variables such as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` are set, profile launches are blocked rather than risking ambiguous billing/authentication.

## Security and privacy

- **Local only:** no cloud account, logging service, analytics or credential exchange.
- **Sensitive transcripts:** JSONL files and backups can contain private prompts, code, tool outputs, paths and secrets. Do not commit or sync these directories, and use disk encryption when possible.
- **No source mutation:** each handoff takes a new backup and forks the destination; the original transcript is read-only.
- **No live migration:** finish outstanding tool calls and exit the source session first. The bridge does not transfer running jobs, background processes, remote control, pending approvals or MCP tokens.
- **Session continuity is not full workspace migration:** `CLAUDE.md`, auto memory, skills, permissions, plugins and rewind checkpoints may differ between profiles; project files stay wherever they were originally stored.
- **No quota bypass:** usage is billed to whichever account Claude Code actually authenticates; this tool does not evade plan restrictions or automatically rotate accounts on rate limits.
- **Defensive defaults:** symlinked transcript files are not indexed; backups use exclusive creation and are discarded if the source changes while it is being copied; no shell evaluates session IDs or filesystem paths.

## Limitations

- Claude Code transcripts are stored locally and their structure is not a stable public interchange format; this CLI reads only a small amount of transcript metadata and delegates conversation loading to Claude Code.
- If Claude Code cannot load a session from another config directory, this version **fails without attempting a risky automatic file import**. See the official session and CLI documentation links below.
- Active sessions should not be handed off; concurrent writes may invalidate backups.
- This tool targets terminal Claude Code sessions, not Claude Desktop, the browser, hosted Claude Code sessions or the VS Code extension's session sidebar.
- Sessions without a discoverable `cwd` can still be transferred using `resume <id>` or `switch --session <id>`; automatic project matching may not work.
- Existing account profile directories must be authenticated separately (`csbridge auth <name>`). Logging into two accounts with the exact same configuration directory overwrites which identity Claude Code uses.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

Tests cover isolated profiles, session discovery, project matching, fork invocation, backups, permissions, missing paths, ambiguous prefixes, auth environment overrides, error propagation, and symlinked transcripts. They mock the Claude executable; CI runs Node 20/22/24 on Linux, macOS and Windows. Live multi-account integration tests remain a release blocker.

## Official references

- [Claude Code: Sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code: CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code: Settings and `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/settings)

MIT licensed. Not affiliated with or endorsed by Anthropic.

## Use with the Claude Code VS Code extension (native chat panel)

If you use **Claude Code's graphical VS Code extension** rather than its CLI, use the companion extension in [`vscode-extension/`](vscode-extension/README.md). It adds Command Palette actions to **Resume Local Session**, **Back Up Local Session**, and display a **Switch Account Guide**. The resume command uses Anthropic's official `vscode://anthropic.claude-code/open?session=...` link, so it targets the native conversation panel, not an integrated terminal.

**Simplest account switch:** leave `~/.claude` as the same session storage location, close the active conversation, sign out and sign in through Claude Code (`/logout`, `/login`), then select your saved conversation in the panel's Session history. No transcript import or account-token copying is necessary. If you intentionally isolate accounts with different `CLAUDE_CONFIG_DIR` folders, note that the VS Code session picker can have compatibility problems with those folders; consult the [companion extension limitations](vscode-extension/README.md). The CLI's cross-profile `--fork-session` workflow is *not* an automatic VS Code chat-panel handoff.

Official references: [Claude Code in VS Code](https://code.claude.com/docs/en/vs-code), especially **Resume past conversations**, **Launch a VS Code tab from other tools**, and **Extension settings**.


## VS Code graphical extension (beta 0.3.0)

If you use the **official Claude Code VS Code chat panel**, use the companion extension in [`vscode-extension/`](vscode-extension/README.md). It offers a searchable session picker, a confirmation-based most-recent-session shortcut, SHA-256-backed private backups, local recovery diagnostics and a resumable handoff before the user signs out and in through Claude's own interface.

Download the installable VSIX artifact from the **VS Code VSIX** GitHub Actions workflow, or build with `cd vscode-extension && npm run package:vsix`. Account authentication remains manual; session restoration requires the source local transcript to be visible to Claude's active configuration. The bridge verifies neither a changed identity nor successful restoration automatically.
