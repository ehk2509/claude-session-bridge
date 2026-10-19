# Claude Session Bridge — VS Code extension

Companion extension for the **official Anthropic Claude Code VS Code chat panel**. It is not a replacement for Claude Code and does not manage credentials.

## Features

Run these commands from VS Code's Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Claude Session Bridge: Resume Local Session** — choose a saved local conversation in the open workspace and use the official `vscode://anthropic.claude-code/open?session=...` handler. **Verify the original messages appear** before continuing. If the session cannot be found, Anthropic's handler may open a fresh conversation instead.
- **Claude Session Bridge: Back Up Local Session** — save a private copy of the selected JSONL transcript outside the project.
- **Claude Session Bridge: Switch Account Guide** — instructions for logging out and in through the *official* Claude Code panel without deleting conversation history. It does not automate authentication.

## Account-switch workflow

1. Open the same project in VS Code; finish or stop the Claude Code turn and close the running chat.
2. Run **Back Up Local Session**.
3. In the official Claude Code panel, run `/logout` and then `/login` for the other account. **Keep the same `~/.claude` config directory** to make the previously saved local sessions available.
4. Use Anthropic's **Session history** UI or **Resume Local Session** and confirm the old messages appear.

**Using different `CLAUDE_CONFIG_DIR` directories for each account?** This extension can inspect the directory set through `claudeCode.environmentVariables`, but Anthropic has documented user-reported issues where the VS Code extension's *host* session-history picker still uses the default `~/.claude` instead of the supplied directory. Switching profiles within one VS Code host is therefore **not guaranteed** to work. This companion extension does **not** copy transcripts between isolated directories, rewrite Anthropic session IDs, patch the official extension, or silently change VS Code settings. The CLI's cross-directory fork flow is available separately, but still needs real two-account validation.

Requires an open **local** workspace; the VS Code handler resumes only sessions matching that workspace. Remote/WSL/containers require local testing: the extension host and the Claude Code process must use the same filesystem.

## Development

```bash
cd vscode-extension
npm run check
# To inspect in VS Code: use the Extension Development Host (F5)
```

There are no runtime dependencies. This extension is not yet published to the VS Code Marketplace.
