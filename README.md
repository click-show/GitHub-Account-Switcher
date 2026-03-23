# GHAS — GitHub Account Switcher

> **Written by Saqib Hussain**

A VS Code extension that lets you save multiple GitHub accounts and switch the active authentication context in seconds — no more logging out and back in, no more broken `git clone` after a switch.

---

## Features

- **Add multiple accounts** — store as many GitHub identities as you need, each with a memorable label (e.g. *Personal*, *Work*, *Client*).
- **One-click switch** — selecting an account logs out the previous session, logs in with the stored token, and re-wires the git credential helper so that `git clone`, `push`, and `pull` all use the correct identity immediately.
- **Clone Repo** — pick any saved account, browse its repositories from the GitHub API, select a target folder, and clone directly — no URL typing required.
- **Refresh token** — re-authenticate any account through VS Code's GitHub sign-in flow without recreating the entry.
- **Remove accounts** — delete saved accounts individually from the sidebar panel.
- **Sidebar Account Manager** — a built-in webview panel shows all saved accounts, highlights the active one, and provides action buttons for every operation.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code `1.110.0`+ | Uses the built-in GitHub authentication provider |
| [GitHub CLI (`gh`)](https://cli.github.com/) | Must be installed and on your `PATH` (or configured via `ghas.ghasPath`) |
| GitHub Authentication extension | Ships with VS Code; required for OAuth sign-in |

---

## Getting Started

1. Install the extension (`.vsix` or from the marketplace).
2. Click the **GHAS** icon in the Activity Bar to open the Account Manager.
3. Click **Add Account**, enter a label, and complete the GitHub sign-in flow in VS Code.
4. Repeat for each GitHub account you want to save.
5. Click **Switch** on any card to activate that account for all `git` and `gh` operations.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ghas.githubScopes` | `["repo", "read:org"]` | OAuth scopes requested when authenticating a GitHub account. |
| `ghas.ghasPath` | `"gh"` | Path or command name for the GitHub CLI executable. Change this if `gh` is not on your `PATH` (e.g. `C:\Tools\gh.exe`). |

---

## Commands

All commands are available in the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) under the **GHAS** category.

| Command | Description |
|---------|-------------|
| `GHAS: Open Account Manager` | Reveal the sidebar Account Manager panel. |
| `GHAS: Add GitHub Account` | Authenticate a new GitHub account and save it. |
| `GHAS: Switch GitHub Account` | Switch the active `gh` / git session to a saved account. |
| `GHAS: Refresh GitHub Account` | Re-authenticate a saved account and update its token. |
| `GHAS: Delete GitHub Account` | Remove a saved account from the extension. |
| `GHAS: Clone Repository with Account` | Browse an account's repos from GitHub and clone the selected one. |

---

## How It Works

When you **Switch** to an account the extension:

1. Runs `gh auth logout --hostname github.com` to clear any existing session.
2. Pipes the stored token into `gh auth login --hostname github.com --with-token`.
3. Runs `gh auth setup-git` to update the git credential helper so every subsequent `git` command uses the new account.

Tokens are stored in VS Code's encrypted secret storage (`SecretStorage` API) — they are never written to disk in plain text.

Token expiry is **not** artificially enforced. GitHub personal access tokens and OAuth tokens remain valid until you revoke them in GitHub → Settings → Developer settings. If a token stops working, use **Refresh Token** to obtain a fresh one.

---

## Troubleshooting

**"`gh` not found"** — Install the [GitHub CLI](https://cli.github.com/) and ensure it is on your `PATH`, or set `ghas.ghasPath` to the full path of the executable.

**"Switch succeeded but clone still fails"** — Run `git credential reject` for the failing URL to clear any cached credentials, then retry. The `gh auth setup-git` step should prevent this in most cases.

**"forceNewSession not supported"** — Older versions of the GitHub Authentication extension may not support forcing a new OAuth session. Update VS Code and its bundled extensions, or sign in to the desired account manually in VS Code's Accounts menu before using **Add Account**.

---

## Release Notes

### 1.0.6
- Launched
---

## License

MIT — see [LICENSE](LICENSE).

---

*Written by Saqib Hussain*
