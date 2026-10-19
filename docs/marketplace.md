# Visual Studio Marketplace publication — preparation

The **GitHub v0.3.0 beta release** and **Visual Studio Marketplace publishing** are separate steps. GitHub releases are built automatically after `main` passes CI. Marketplace publishing is **manual and requires explicit authorization**; the workflow does not run on pushes or tags.

## One-time publisher setup

1. Sign in to [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage) with the Microsoft identity that owns the publisher.
2. Confirm the publisher ID is **`ehk2509`**, matching `vscode-extension/package.json`. If a different existing publisher should be used, update and review the manifest before publishing; do not guess.
3. In Marketplace publisher management, configure a **trusted GitHub Actions publishing policy** for:
   - GitHub repository: `ehk2509/claude-session-bridge`
   - Workflow: `.github/workflows/marketplace-publish.yml`
   - Branch/ref: `main` (and any environment constraints required by the trust policy)
4. Under **GitHub → Settings → Environments**, create `vscode-marketplace`, restrict deployments to `main` and configure required reviewers before first use. If the environment does not exist, GitHub may create it without reviewer protections.
5. Confirm the extension description, publisher rights, open-source license, README and expected Marketplace listing prior to publication.

[VS Code official publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) · [Microsoft vsce trusted publishing documentation](https://github.com/microsoft/vscode-vsce#trusted-publishing)

## First publish (after a real v0.3.0 smoke test)

1. Verify [the GitHub v0.3.0 release](https://github.com/ehk2509/claude-session-bridge/releases/tag/v0.3.0) exists and includes **the VSIX and SHA256SUMS**.
2. In VS Code, test Quick Account Handoff with two Claude accounts, confirm the original conversation appears and work can continue, and check the recovery diagnosis command.
3. From GitHub, go to **Actions → Publish VS Code extension to Marketplace (manual) → Run workflow** on `main`, using tag `v0.3.0`.
4. Approve the `vscode-marketplace` environment if your protection rules require it.
5. Inspect the workflow logs, then verify the extension version **0.3.0** in the [Marketplace publisher dashboard](https://marketplace.visualstudio.com/manage) and via a fresh VS Code Marketplace search.

The workflow downloads **exactly the approved GitHub release VSIX**, verifies its checksum, and invokes `@vscode/vsce@4.0.0 publish --packagePath ... --oidc`. It uses GitHub's short-lived OIDC token to exchange for Marketplace credentials, not long-lived PAT secrets. Publishing will fail until a matching Marketplace trusted-publisher policy exists. It does **not** silently fall back to a PAT.

**Do not paste any access tokens or local Claude transcript backups in GitHub issues.**
