# Changelog

## Terminal CLI 0.2.0 — 2026-10-20

- SHA-256 checksum manifests for private backups and explicit `csbridge verify`.
- Persistent pending handoffs across terminal restarts, safe `csbridge pending` diagnostics, `csbridge retry`, and `csbridge finish --confirmed`.
- `csbridge quick` previews the current-project saved session and requires user confirmation; noninteractive use requires `--yes`.
- Tests cover tampering, interrupted runs, missing source transcripts, invalid metadata, confirmation and recovery.
- **No npm publication or real CLI cross-account smoke test claimed.** VS Code extension remains v0.3.2.


## VS Code extension 0.3.2 — 2026-10-20

- Resize the approved neon bridge icon to **512 × 512** with transparency. Marketplace rejected the 1254 × 1254 logo in v0.3.1 because it exceeded the maximum 1024 × 1024 icon dimensions.
- Add CI enforcement of icon dimensions and release a fresh immutable v0.3.2 VSIX under publisher `ElyesHkiri`.
- No change to Claude Code account handoff, local backups or recovery diagnostics.


## VS Code extension 0.3.1 — 2026-10-20

- Register the new neon session-bridge PNG logo at `vscode-extension/media/icon.png` for VS Code / Marketplace.
- Set Marketplace publisher to `ElyesHkiri` (GitHub repository owner remains `ehk2509`).
- Update version, release pipeline, downloadable VSIX references, and Marketplace publisher validation.
- No session-handling behavior changes. Existing `v0.3.0` artifacts are left unchanged.

## VS Code extension 0.3.0 — 2026-10-19

- **Quick Account Handoff** command and always-available status bar shortcut. Suggestions are based on recent transcript writes and require user confirmation; active chat IDs are not exposed by the official API.
- Private transcript backup with a recorded SHA-256 digest. Pending handoffs persist across reloads and are never marked successful without explicit confirmation.
- **Diagnose Session Recovery** command checks original workspace, Claude Code installation, config directory, backup integrity and transcript availability without logging conversation text or credentials.
- Detection of inherited `CLAUDE_CONFIG_DIR`; hardened handling of damaged handoff metadata and missing backups.
- Version-independent VSIX packaging and CI artifact path; compatibility tests for regressions and recovery.

The CLI remains at 0.1.0. Real-world session continuity has been confirmed by one user with two Claude accounts on Linux in VS Code; broader version, OS and configuration coverage remains to be tested.

## VS Code extension 0.2.0

- Searchable local session picker, verified workspace matching, private backups, handoff wizard, pending record recovery, and native VS Code Claude Code URI resume.
