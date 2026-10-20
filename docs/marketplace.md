# Publish Claude Session Bridge to the VS Code Marketplace

This project uses **the same GitHub Actions / Azure DevOps PAT method that published Codico**. The GitHub owner remains `ehk2509`; the *Marketplace publisher* is `ElyesHkiri`. It does **not** require Marketplace Trusted Publishing or GitHub OIDC configuration.

**Status:** [GitHub beta release v0.3.1](https://github.com/ehk2509/claude-session-bridge/releases/tag/v0.3.1) is published. Marketplace publication requires the owner to configure the publisher and an Actions secret, then manually run the workflow.

## 1. Confirm the Marketplace publisher

Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/) and sign in with your Microsoft account. Create or select publisher **`ElyesHkiri`**.

Make sure your Microsoft identity has publishing rights under **`ElyesHkiri`** in Marketplace publisher management. The VSIX's manifest uses:
- Publisher ID: `ElyesHkiri`
- Extension name: `claude-session-bridge-vscode`
- Version: `0.3.1`
- Expected listing: [`ElyesHkiri.claude-session-bridge-vscode`](https://marketplace.visualstudio.com/items?itemName=ElyesHkiri.claude-session-bridge-vscode)

**Codico uses a different publisher, `codico`.** Do not paste `codico` into this extension's manifest unless you explicitly intend to publish it under that publisher and rebuild the release VSIX.

## 2. Create or reuse an Azure DevOps PAT

This is the same approach used for Codico:

1. Open [Azure DevOps Personal Access Tokens](https://dev.azure.com/_usersSettings/tokens) and sign in with a Microsoft identity authorized to publish under `ElyesHkiri`.
2. Create a new token, or reuse your existing Codico PAT **only if it still works and that Microsoft identity has publishing rights on `ElyesHkiri`**.
3. For a new token, choose a short expiration, the organization coverage required by Marketplace (Microsoft's current VS Code extension publishing guide specifies **All accessible organizations**), and **Custom defined → Show all scopes → Marketplace → Manage**.
4. Copy the PAT securely. Do not put it into a source file, discussion, commit, shell history, or chat.

> **Important:** Microsoft's publishing documentation says that **global Azure DevOps PATs retire December 1, 2026**. This reproduces the Codico workflow for now, but future releases should migrate to Microsoft Entra ID authentication. See the [official VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## 3. Add the secret to this repository

Open [Claude Session Bridge → GitHub Actions secrets](https://github.com/ehk2509/claude-session-bridge/settings/secrets/actions).

Select **New repository secret** and use the **exact** name:

```text
VSCE_PAT
```

Paste the PAT as the *secret value* and save it. The secret configured in the **Codico** repository is **not automatically shared** with the Claude Session Bridge repository. GitHub and ChatGPT cannot read its saved value back.

No `VSCE_PA`, `OVSX_PAT`, OIDC trust policy or `vscode-marketplace` environment is required for this Codico-style workflow.

## 4. Publish manually using GitHub Actions

After verifying the v0.3.1 VSIX works in VS Code:

1. Visit [Publish VS Code extension to Marketplace (manual)](https://github.com/ehk2509/claude-session-bridge/actions/workflows/marketplace-publish.yml).
2. Choose **Run workflow** → Branch **`main`**, release tag **`v0.3.1`** → **Run workflow**.
3. The workflow downloads the **already published** GitHub release VSIX and its `SHA256SUMS`, verifies the package integrity and publisher ID, then runs `@vscode/vsce publish --packagePath` with `VSCE_PAT` injected securely from GitHub Actions.
4. Inspect the workflow outcome and check the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=ElyesHkiri.claude-session-bridge-vscode). Marketplace processing may take time.

The workflow runs **only when manually dispatched from `main`**, and hard-checks the release tag and package identity. It does not automatically republish on every push.

If version `0.3.1` has already been published under `ElyesHkiri` in Marketplace, don't run the same publish again. Bump the version and create a fresh verified VSIX/release for the next publication.

## Security notes

- A GitHub Actions PAT is a sensitive credential; use minimal expiry and rotate/revoke it when needed.
- Do not upload your local Claude session JSONL backups to GitHub or Marketplace.
- The CLI remains version `0.1.0`; only the VS Code companion is at `0.3.1`.
