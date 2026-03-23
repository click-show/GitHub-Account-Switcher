import * as vscode from 'vscode';
import * as cp from 'child_process';
import { buildLaunchCandidates, resolvePreferredBins } from './ghasCli';

type SavedGithubAccount = {
  label: string;          // e.g., "Personal", "Client"
  accountLabel: string;   // e.g., "you@example.com"
  accessToken: string;    // GitHub access token
  tokenExpiry?: number;   // Token expiry timestamp (optional, only set when explicitly known)
};

const GHAS_SCOPES_KEY = 'ghas.githubScopes';
const GHAS_BIN_KEY = 'ghas.ghasPath';
const SAVED_ACCOUNTS_SECRET = 'ghas.savedGithubAccounts';
const ACTIVE_ACCOUNT_STATE_KEY = 'ghas.activeAccountId';
const ACCOUNT_MANAGER_CONTAINER_ID = 'ghas';
const ACCOUNT_MANAGER_VIEW_ID = 'ghas.accountManager';

const COMMANDS = {
  openManager: 'ghas.openManager',
  addAccount: 'ghas.addAccount',
  switchAccount: 'ghas.switchAccount',
  refreshAccount: 'ghas.refreshAccount',
  deleteAccount: 'ghas.deleteAccount',
  cloneWithAccount: 'ghas.cloneWithAccount'
};

export async function activate(ctx: vscode.ExtensionContext) {
  const disposables: vscode.Disposable[] = [];
  let accountManagerSidebarView: vscode.WebviewView | undefined;

  disposables.push(vscode.window.registerWebviewViewProvider(
    ACCOUNT_MANAGER_VIEW_ID,
    {
      resolveWebviewView: async (webviewView: vscode.WebviewView) => {
        accountManagerSidebarView = webviewView;
        const messageListener = await initializeAccountManagerWebview(webviewView.webview, ctx);
        const viewDisposeListener = webviewView.onDidDispose(() => {
          if (accountManagerSidebarView === webviewView) {
            accountManagerSidebarView = undefined;
          }
          messageListener.dispose();
          viewDisposeListener.dispose();
        });
      }
    },
    {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  ));

  disposables.push(vscode.commands.registerCommand(COMMANDS.openManager, async () => {
    await revealAccountManagerView(accountManagerSidebarView);
  }));

  // ---- GitHub Account Management ----
  const addAccountHandler = async (prefilledLabel?: string): Promise<string | undefined> => {
    try {
      const config = vscode.workspace.getConfiguration();
      const scopes = getScopes(config);

      // Check if GitHub authentication is available
      if (!isGithubAuthenticationAvailable()) {
        vscode.window.showErrorMessage('GitHub authentication not available. Please install the GitHub Authentication extension.');
        return;
      }

      // Use the prefilled label from the webview UI, or fall back to showInputBox
      const label = prefilledLabel?.trim()
        ? prefilledLabel.trim()
        : await vscode.window.showInputBox({
            prompt: 'Label this GitHub account (e.g., Personal, Client)',
            placeHolder: 'Personal'
          });
      if (!label) return;

      // Force new session so you can add a different account.
      // Use the object form of forceNewSession with a detail message so VS Code shows
      // a clear "sign in as a different account" prompt instead of the "Incorrect account
      // detected" mismatch dialog that appears when passing forceNewSession: true while
      // another account is already active.
      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession(
          'github',
          scopes,
          { forceNewSession: { detail: 'Sign in with the GitHub account you want to add to GHAS.' }, silent: false }
        );
      } catch {
        // forceNewSession may throw in some VS Code versions/environments; fall back gracefully
        session = await vscode.authentication.getSession(
          'github',
          scopes,
          { createIfNone: true, silent: false }
        );
      }
      if (!session) return;

      const accounts = await getSavedAccounts(ctx);

      // Check for duplicate account (same GitHub username/label)
      const duplicate = accounts.find(
        a => isSameGithubAccount(a.accountLabel, session!.account.label) &&
             a.label.trim().toLowerCase() === label.trim().toLowerCase()
      );
      if (duplicate) {
        const action = await vscode.window.showWarningMessage(
          `An account already exists with label "${label}" and GitHub user "${session.account.label}". Overwrite the token?`,
          'Overwrite', 'Cancel'
        );
        if (action !== 'Overwrite') return;
        duplicate.accessToken = session.accessToken;
        // Clear artificial expiry — tokens are valid until revoked
        duplicate.tokenExpiry = undefined;
        await saveAccounts(ctx, accounts);
        const message = `GitHub account token updated: ${label} (${session.account.label})`;
        vscode.window.showInformationMessage(message);
        return message;
      }

      accounts.push({
        label,
        accountLabel: session.account.label,
        accessToken: session.accessToken
        // No artificial tokenExpiry — GitHub PATs are valid until manually revoked
      });
      await saveAccounts(ctx, accounts);

      const message = `GitHub account saved: ${label} (${session.account.label})`;
      vscode.window.showInformationMessage(message);
      return message;
    } catch (error) {
      vscode.window.showErrorMessage(`GitHub authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return undefined;
  };
  disposables.push(vscode.commands.registerCommand(COMMANDS.addAccount, addAccountHandler));

  const switchAccountHandler = async (accountId?: string): Promise<string | undefined> => {
    try {
      const config = vscode.workspace.getConfiguration();
      const ghasBin = getGhasBin(config);

      // Check if GitHub authentication is available
      if (!isGithubAuthenticationAvailable()) {
        vscode.window.showErrorMessage('GitHub authentication not available. Please install the GitHub Authentication extension.');
        return;
      }

      const accounts = await getSavedAccounts(ctx);
      if (!accounts.length) {
        vscode.window.showWarningMessage('No saved GitHub accounts. Run "GHAS: Add GitHub Account" first.');
        return;
      }

      const chosen = accountId
        ? accounts.find(a => getAccountId(a) === accountId)
        : await pickAccount(accounts, 'Select the GitHub account to activate for GHAS/API');
      if (accountId && !chosen) {
        vscode.window.showErrorMessage('The selected account no longer exists. Refresh the GHAS account list.');
        return;
      }
      if (!chosen) return;

      // Use the stored token directly — no artificial expiry check
      const token = chosen.accessToken;

      // Log out existing account first to ensure clean state, then log in with new token
      await logoutFromGhas(ghasBin);
      await loginToGhas(ghasBin, token);
      await setupGitAuthForGhas(ghasBin);
      await ctx.globalState.update(ACTIVE_ACCOUNT_STATE_KEY, getAccountId(chosen));

      const message = `Switched to GitHub account: ${chosen.accountLabel} (${chosen.label})`;
      vscode.window.showInformationMessage(message);
      return message;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to switch account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return undefined;
  };
  disposables.push(vscode.commands.registerCommand(COMMANDS.switchAccount, switchAccountHandler));

  const refreshAccountHandler = async (accountId?: string): Promise<string | undefined> => {
    try {
      const config = vscode.workspace.getConfiguration();
      const scopes = getScopes(config);
      const ghasBin = getGhasBin(config);

      // Check if GitHub authentication is available
      if (!isGithubAuthenticationAvailable()) {
        vscode.window.showErrorMessage('GitHub authentication not available. Please install the GitHub Authentication extension.');
        return;
      }

      const accounts = await getSavedAccounts(ctx);
      if (!accounts.length) {
        vscode.window.showWarningMessage('No saved GitHub accounts. Run "GHAS: Add GitHub Account" first.');
        return;
      }

      const chosen = accountId
        ? accounts.find(a => getAccountId(a) === accountId)
        : await pickAccount(accounts, 'Select the GitHub account to refresh');
      if (accountId && !chosen) {
        vscode.window.showErrorMessage('The selected account no longer exists. Refresh the GHAS account list.');
        return;
      }
      if (!chosen) return;

      // Force a fresh session for the specific saved account so VS Code knows which
      // account to re-authenticate. Passing `account` prevents the "Incorrect account
      // detected" mismatch dialog that appears when the currently active VS Code session
      // belongs to a different GitHub user than the one being refreshed.
      let session: vscode.AuthenticationSession | undefined;
      try {
        session = await vscode.authentication.getSession('github', scopes, {
          account: { id: chosen.accountLabel, label: chosen.accountLabel },
          forceNewSession: { detail: `Re-authenticate as ${chosen.accountLabel} to refresh the stored token.` },
          silent: false
        });
      } catch {
        // forceNewSession or account-scoped lookup may fail on older VS Code builds; fall back gracefully
        session = await vscode.authentication.getSession('github', scopes, {
          createIfNone: true, silent: false
        });
      }
      if (!session) return;

      // Guard against accidentally storing a token from a different signed-in account.
      if (!isSameGithubAccount(session.account.label, chosen.accountLabel)) {
        vscode.window.showErrorMessage(
          `Selected sign-in account (${session.account.label}) does not match "${chosen.accountLabel}". Refresh cancelled.`
        );
        return;
      }

      // Update the saved account with new token
      const accountIndex = accounts.findIndex(a => getAccountId(a) === getAccountId(chosen));
      if (accountIndex !== -1) {
        const accountToUpdate = accounts[accountIndex];
        if (!accountToUpdate) {
          throw new Error('Selected account could not be updated.');
        }

        accountToUpdate.accessToken = session.accessToken;
        // Clear expiry — token is freshly obtained and valid until revoked
        accountToUpdate.tokenExpiry = undefined;
        await saveAccounts(ctx, accounts);

        // Also switch gh CLI to use the refreshed token
        await logoutFromGhas(ghasBin);
        await loginToGhas(ghasBin, session.accessToken);
        await setupGitAuthForGhas(ghasBin);
        await ctx.globalState.update(ACTIVE_ACCOUNT_STATE_KEY, getAccountId(chosen));
        const message = `Account "${chosen.label}" token refreshed and activated.`;
        vscode.window.showInformationMessage(message);
        return message;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return undefined;
  };
  disposables.push(vscode.commands.registerCommand(COMMANDS.refreshAccount, refreshAccountHandler));

  const deleteAccountHandler = async (accountId?: string, skipConfirmation = false): Promise<string | undefined> => {
    try {
      const accounts = await getSavedAccounts(ctx);
      if (!accounts.length) {
        vscode.window.showWarningMessage('No saved GitHub accounts to delete.');
        return;
      }

      const chosen = accountId
        ? accounts.find(a => getAccountId(a) === accountId)
        : await pickAccount(accounts, 'Select the GitHub account to delete from GHAS');
      if (accountId && !chosen) {
        vscode.window.showErrorMessage('The selected account no longer exists. Refresh the GHAS account list.');
        return;
      }
      if (!chosen) return;

      if (!skipConfirmation) {
        const confirmation = await vscode.window.showWarningMessage(
          `Delete account "${formatAccount(chosen)}" from GHAS saved accounts?`,
          { modal: true },
          'Delete'
        );
        if (confirmation !== 'Delete') return;
      }

      const filteredAccounts = accounts.filter(a => getAccountId(a) !== getAccountId(chosen));
      await saveAccounts(ctx, filteredAccounts);
      const activeAccountId = getActiveAccountId(ctx);
      if (activeAccountId === getAccountId(chosen)) {
        await ctx.globalState.update(ACTIVE_ACCOUNT_STATE_KEY, undefined);
      }
      const message = `Deleted account "${formatAccount(chosen)}" from GHAS.`;
      vscode.window.showInformationMessage(message);
      return message;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete account: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return undefined;
  };
  disposables.push(vscode.commands.registerCommand(COMMANDS.deleteAccount, deleteAccountHandler));

  const cloneWithAccountHandler = async (accountId?: string): Promise<string | undefined> => {
    try {
      const config = vscode.workspace.getConfiguration();
      const ghasBin = getGhasBin(config);

      if (!isGithubAuthenticationAvailable()) {
        vscode.window.showErrorMessage('GitHub authentication not available. Please install the GitHub Authentication extension.');
        return;
      }

      const accounts = await getSavedAccounts(ctx);
      if (!accounts.length) {
        vscode.window.showWarningMessage('No saved GitHub accounts. Run "GHAS: Add GitHub Account" first.');
        return;
      }

      const chosen = accountId
        ? accounts.find(a => getAccountId(a) === accountId)
        : await pickAccount(accounts, 'Select the GitHub account to use for cloning');
      if (accountId && !chosen) {
        vscode.window.showErrorMessage('The selected account no longer exists. Refresh the GHAS account list.');
        return;
      }
      if (!chosen) return;

      // Fetch the user's repos from the GitHub API using the stored token
      let repos: GithubRepo[];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading repos for ${chosen.accountLabel}…`, cancellable: false },
        async () => {
          repos = await fetchUserRepos(chosen.accessToken);
        }
      );
      repos = repos!;

      if (!repos.length) {
        vscode.window.showWarningMessage(`No repositories found for ${chosen.accountLabel}.`);
        return;
      }

      // Show a searchable QuickPick of repos
      type RepoPickItem = vscode.QuickPickItem & { cloneUrl: string; repoName: string };
      const items: RepoPickItem[] = repos.map(r => ({
        label: r.full_name,
        description: r.private ? '$(lock) private' : '$(globe) public',
        detail: r.description ?? undefined,
        cloneUrl: r.clone_url,
        repoName: r.name
      }));

      const picked = await vscode.window.showQuickPick<RepoPickItem>(items, {
        placeHolder: `Pick a repo to clone as ${formatAccount(chosen)}`,
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!picked) return;

      // Pick a directory to clone into
      const targetUris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Clone here',
        title: 'Select the parent folder for the cloned repository'
      });
      const targetDir = targetUris?.[0]?.fsPath;
      if (!targetDir) return;

      // Switch gh CLI to the chosen account so credential helper uses the right token
      await logoutFromGhas(ghasBin);
      await loginToGhas(ghasBin, chosen.accessToken);
      await setupGitAuthForGhas(ghasBin);
      await ctx.globalState.update(ACTIVE_ACCOUNT_STATE_KEY, getAccountId(chosen));

      // Run git clone; gh auth setup-git configures git to use gh as a credential helper
      const terminal = vscode.window.createTerminal({
        name: `GHAS Clone — ${chosen.label}`,
        cwd: targetDir
      });
      terminal.show();
      terminal.sendText(`git clone ${picked.cloneUrl}`);

      const message = `Cloning ${picked.label} as ${formatAccount(chosen)} in ${targetDir}`;
      vscode.window.showInformationMessage(message);
      return message;
    } catch (error) {
      vscode.window.showErrorMessage(`Clone failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return undefined;
  };
  disposables.push(vscode.commands.registerCommand(COMMANDS.cloneWithAccount, cloneWithAccountHandler));

  ctx.subscriptions.push(...disposables);
}

export function deactivate() {}

type GithubRepo = {
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
};

/**
 * Fetch all repos accessible to the authenticated user via the GitHub REST API.
 * Paginates up to 500 repos (5 pages × 100 per page) to avoid fetching forever.
 */
async function fetchUserRepos(token: string): Promise<GithubRepo[]> {
  const allRepos: GithubRepo[] = [];
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub API error (${response.status}): ${text || response.statusText}`);
    }

    const page_repos = await response.json() as GithubRepo[];
    if (!Array.isArray(page_repos) || page_repos.length === 0) {
      break;
    }

    allRepos.push(...page_repos);

    if (page_repos.length < 100) {
      break; // Last page — no need to keep fetching
    }
  }

  return allRepos;
}

async function getSavedAccounts(ctx: vscode.ExtensionContext): Promise<SavedGithubAccount[]> {
  const raw = await ctx.secrets.get(SAVED_ACCOUNTS_SECRET);
  return raw ? parseAccounts(raw) : [];
}

async function saveAccounts(ctx: vscode.ExtensionContext, accounts: SavedGithubAccount[]): Promise<void> {
  await ctx.secrets.store(SAVED_ACCOUNTS_SECRET, JSON.stringify(accounts));
}

function parseAccounts(raw: string): SavedGithubAccount[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as SavedGithubAccount[] : [];
  } catch {
    return [];
  }
}

function isGithubAuthenticationAvailable(): boolean {
  return typeof vscode.authentication.getSession === 'function';
}

function getScopes(config: vscode.WorkspaceConfiguration): string[] {
  return config.get<string[]>(GHAS_SCOPES_KEY)
    ?? ['repo', 'read:org'];
}

function getGhasBin(config: vscode.WorkspaceConfiguration): string {
  const configuredBin = (config.get<string>(GHAS_BIN_KEY) ?? 'gh').trim();
  if (!configuredBin) {
    return 'gh';
  }

  return configuredBin;
}

function formatAccount(account: SavedGithubAccount): string {
  return `${account.label} (${account.accountLabel})`;
}

function getAccountId(account: SavedGithubAccount): string {
  return `${account.label}::${account.accountLabel}`;
}

async function pickAccount(accounts: SavedGithubAccount[], placeHolder: string): Promise<SavedGithubAccount | undefined> {
  const pick = await vscode.window.showQuickPick(
    accounts.map(formatAccount),
    { placeHolder }
  );
  if (!pick) return undefined;
  return accounts.find(a => formatAccount(a) === pick);
}

/**
 * Log out of gh CLI to ensure a clean state before logging in as a different account.
 * We silence errors here because the user may not have been logged in at all.
 */
async function logoutFromGhas(ghasBin: string): Promise<void> {
  try {
    await runGhasCommand(ghasBin, ['auth', 'logout', '--hostname', 'github.com']);
  } catch {
    // Ignore logout failures — if not logged in, logout will fail; that is fine.
  }
}

async function loginToGhas(ghasBin: string, token: string): Promise<void> {
  await runGhasCommand(ghasBin, ['auth', 'login', '--hostname', 'github.com', '--with-token'], token + '\n');
}

/**
 * Configure git to use gh as a credential helper so that git clone / push / pull
 * use the currently active gh CLI account token.
 */
async function setupGitAuthForGhas(ghasBin: string): Promise<void> {
  await runGhasCommand(ghasBin, ['auth', 'setup-git']);
}

async function runGhasCommand(ghasBin: string, args: string[], stdinData?: string): Promise<void> {
  const preferredBins = resolvePreferredBins(ghasBin);
  const launchCandidates = buildLaunchCandidates(preferredBins);
  const attemptedBins: string[] = [];

  for (const candidate of launchCandidates) {
    attemptedBins.push(candidate);
    try {
      await runSingleCliCommand(candidate, args, stdinData);
      return;
    } catch (error) {
      const launchError = error as NodeJS.ErrnoException;
      if (launchError.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `GHAS CLI not found. Tried: ${attemptedBins.map(bin => `"${bin}"`).join(', ')}. Set "ghas.ghasPath" to your GHAS executable (for example: C:\\Tools\\ghas.exe) or "gh", then reload VS Code.`
  );
}

async function runSingleCliCommand(bin: string, args: string[], stdinData?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = cp.spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => reject(err));
    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      const stderrSummary = stderr.trim();
      if (stderrSummary) {
        reject(new Error(`"${bin} ${args.join(' ')}" exited with ${code}: ${stderrSummary}`));
        return;
      }

      reject(new Error(`"${bin} ${args.join(' ')}" exited with ${code}`));
    });
  });
}

function isSameGithubAccount(current: string, expected: string): boolean {
  return current.trim().toLowerCase() === expected.trim().toLowerCase();
}

type ManagerNotice = {
  kind: 'success' | 'error' | 'info';
  text: string;
};

async function revealAccountManagerView(sidebarView?: vscode.WebviewView): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${ACCOUNT_MANAGER_CONTAINER_ID}`);
  if (sidebarView) {
    sidebarView.show?.(true);
    return;
  }

  try {
    await vscode.commands.executeCommand(`${ACCOUNT_MANAGER_VIEW_ID}.focus`);
  } catch {
    // Focus command is generated by VS Code and may be unavailable in some builds.
  }
}

async function initializeAccountManagerWebview(
  webview: vscode.Webview,
  ctx: vscode.ExtensionContext
): Promise<vscode.Disposable> {
  webview.options = {
    enableScripts: true
  };

  const render = async (notice?: ManagerNotice) => {
    const accounts = await getSavedAccounts(ctx);
    webview.html = getAccountManagerHtml(webview, accounts, getActiveAccountId(ctx), notice);
  };

  const messageListener = webview.onDidReceiveMessage(async (message: { type?: string; accountId?: string; label?: string }) => {
    const accountId = decodeAccountId(message.accountId);
    try {
      switch (message.type) {
        case 'refreshList':
          await render();
          return;
        case 'add': {
          const result = await vscode.commands.executeCommand<string | undefined>(COMMANDS.addAccount, message.label);
          await render(result ? { kind: 'success', text: result } : { kind: 'info', text: 'Add account cancelled.' });
          return;
        }
        case 'switch': {
          if (!accountId) {
            await render({ kind: 'error', text: 'Select an account to switch.' });
            return;
          }
          const result = await vscode.commands.executeCommand<string | undefined>(COMMANDS.switchAccount, accountId);
          await render(result ? { kind: 'success', text: result } : { kind: 'info', text: 'Switch account cancelled.' });
          return;
        }
        case 'refreshToken': {
          if (!accountId) {
            await render({ kind: 'error', text: 'Select an account to refresh.' });
            return;
          }
          const result = await vscode.commands.executeCommand<string | undefined>(COMMANDS.refreshAccount, accountId);
          await render(result ? { kind: 'success', text: result } : { kind: 'info', text: 'Refresh cancelled.' });
          return;
        }
        case 'delete': {
          if (!accountId) {
            await render({ kind: 'error', text: 'Select an account to delete.' });
            return;
          }
          const result = await vscode.commands.executeCommand<string | undefined>(COMMANDS.deleteAccount, accountId, true);
          await render(result ? { kind: 'success', text: result } : { kind: 'info', text: 'Delete cancelled.' });
          return;
        }
        case 'clone': {
          if (!accountId) {
            await render({ kind: 'error', text: 'Select an account to clone with.' });
            return;
          }
          const result = await vscode.commands.executeCommand<string | undefined>(COMMANDS.cloneWithAccount, accountId);
          await render(result ? { kind: 'success', text: result } : { kind: 'info', text: 'Clone cancelled.' });
          return;
        }
        default:
          await render({ kind: 'error', text: 'Unsupported action.' });
      }
    } catch (error) {
      await render({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Unexpected error while handling UI action.'
      });
    }
  });

  await render();
  return messageListener;
}

function getActiveAccountId(ctx: vscode.ExtensionContext): string | undefined {
  return ctx.globalState.get<string>(ACTIVE_ACCOUNT_STATE_KEY);
}

function decodeAccountId(encoded?: string): string | undefined {
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function getAccountManagerHtml(
  webview: vscode.Webview,
  accounts: SavedGithubAccount[],
  activeAccountId?: string,
  notice?: ManagerNotice
): string {
  const nonce = getNonce();
  const noticeHtml = notice
    ? `<div class="notice ${notice.kind}">${escapeHtml(notice.text)}</div>`
    : '';

  const accountsHtml = accounts.length
    ? accounts.map(account => {
      const accountId = getAccountId(account);
      const encodedAccountId = encodeURIComponent(accountId);
      const tokenState = describeTokenState(account.tokenExpiry);
      const isActive = accountId === activeAccountId;
      const activeClass = isActive ? 'account-card active' : 'account-card';
      const activeBadge = isActive ? '<span class="badge active">Active</span>' : '';
      const avatarChar = escapeHtml((account.label || account.accountLabel || '?')[0] || '?');
      return `
        <article class="${activeClass}">
          <div class="card-header">
            <div class="card-meta">
              <div class="account-title">${escapeHtml(account.label)}</div>
              <div class="account-handle">${escapeHtml(account.accountLabel)}</div>
            </div>
            <div class="account-avatar">${avatarChar}</div>
          </div>
          <div class="card-badges">
            ${activeBadge}
            <span class="badge ${tokenState.kind}">${escapeHtml(tokenState.label)}</span>
          </div>
          <div class="card-actions">
            <button data-action="switch" data-account-id="${encodedAccountId}" class="btn accent">Switch</button>
            <button data-action="clone" data-account-id="${encodedAccountId}" class="btn clone">Clone</button>
            <button data-action="refreshToken" data-account-id="${encodedAccountId}" class="btn">Refresh</button>
            <button data-action="delete" data-account-id="${encodedAccountId}" class="btn danger">Remove</button>
          </div>
        </article>
      `;
    }).join('')
    : `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        </div>
        <h3>No accounts yet</h3>
        <p>Add your first GitHub account to quickly switch between GHAS identities.</p>
      </div>
    `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>GHAS — GitHub Account Switcher</title>
  <style>
    /* ── Reset & tokens ───────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      /* Palette */
      --c-bg:         #0d1117;
      --c-surface:    #161b22;
      --c-surface-2:  #1c2433;
      --c-border:     rgba(48, 54, 61, 0.9);
      --c-border-focus: rgba(30, 165, 199, 0.75);
      --c-text:       #e6edf3;
      --c-muted:      #7d8fa0;
      --c-accent:     #1ea5c7;
      --c-accent-dim: rgba(30, 165, 199, 0.14);
      --c-ok:         #3fb950;
      --c-ok-dim:     rgba(63, 185, 80, 0.14);
      --c-danger:     #f85149;
      --c-danger-dim: rgba(248, 81, 73, 0.14);
      --c-clone:      #3dc990;
      --c-clone-dim:  rgba(61, 201, 144, 0.14);
      --c-warn:       #d29922;

      /* Geometry */
      --radius-sm:  6px;
      --radius:     10px;
      --radius-lg:  14px;
      --shadow-card: 0 1px 3px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.25);
      --shadow-active: 0 0 0 2px rgba(30,165,199,0.55), 0 4px 20px rgba(30,165,199,0.12);

      /* Motion */
      --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
    }

    body {
      font-family: -apple-system, "Segoe UI", "SF Pro Text", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--c-text);
      background: var(--c-bg);
      padding: 12px;
      -webkit-font-smoothing: antialiased;
    }

    /* ── App shell ────────────────────────────────────────────────── */
    .app {
      display: flex;
      flex-direction: column;
      gap: 0;
      max-width: 900px;
      margin: 0 auto;
    }

    /* ── Top bar ──────────────────────────────────────────────────── */
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 14px 16px;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-bottom: none;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      position: relative;
    }
    .topbar::after {
      content: '';
      position: absolute;
      bottom: 0; left: 16px; right: 16px;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--c-border), transparent);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-icon {
      width: 30px; height: 30px;
      border-radius: var(--radius-sm);
      background: linear-gradient(135deg, var(--c-accent), #0e7490);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(30,165,199,0.3);
    }
    .brand-icon svg { width: 16px; height: 16px; fill: #fff; }
    .brand-text { display: flex; flex-direction: column; gap: 1px; }
    .brand-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--c-text);
      letter-spacing: 0.06em;
      line-height: 1;
    }
    .brand-sub {
      font-size: 11px;
      color: var(--c-muted);
      letter-spacing: 0.01em;
    }

    .toolbar { display: flex; gap: 6px; flex-wrap: wrap; }

    /* ── Content area ─────────────────────────────────────────────── */
    .content {
      padding: 14px 16px 16px;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-top: 1px solid rgba(48, 54, 61, 0.5);
      border-radius: 0 0 var(--radius-lg) var(--radius-lg);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* ── Notice banner ────────────────────────────────────────────── */
    .notice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 9px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      border: 1px solid transparent;
      animation: slideDown 200ms var(--ease);
    }
    .notice::before {
      content: '';
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 4px;
    }
    .notice.success {
      background: var(--c-ok-dim);
      border-color: rgba(63,185,80,0.3);
      color: #7ee787;
    }
    .notice.success::before { background: var(--c-ok); }
    .notice.error {
      background: var(--c-danger-dim);
      border-color: rgba(248,81,73,0.3);
      color: #ff8a80;
    }
    .notice.error::before { background: var(--c-danger); }
    .notice.info {
      background: var(--c-accent-dim);
      border-color: rgba(30,165,199,0.3);
      color: #79c8e8;
    }
    .notice.info::before { background: var(--c-accent); }

    /* ── Add-account inline form ──────────────────────────────────── */
    .add-form {
      background: var(--c-surface-2);
      border: 1px solid var(--c-border-focus);
      border-radius: var(--radius-lg);
      padding: 14px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: slideDown 180ms var(--ease);
    }
    .add-form-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--c-accent);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--c-muted);
    }
    .field-input {
      background: var(--c-bg);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-sm);
      color: var(--c-text);
      font-size: 13px;
      font-family: inherit;
      padding: 7px 10px;
      outline: none;
      transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease);
      width: 100%;
    }
    .field-input::placeholder { color: rgba(125, 143, 160, 0.5); }
    .field-input:focus {
      border-color: var(--c-accent);
      box-shadow: 0 0 0 3px rgba(30,165,199,0.15);
    }
    .form-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    /* ── Buttons ──────────────────────────────────────────────────── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: var(--radius-sm);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 120ms var(--ease), transform 120ms var(--ease), box-shadow 120ms var(--ease);
      border: 1px solid transparent;
      white-space: nowrap;
      background: rgba(255,255,255,0.05);
      border-color: var(--c-border);
      color: var(--c-text);
    }
    .btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.09);
      border-color: rgba(99, 118, 140, 0.7);
      transform: translateY(-1px);
    }
    .btn:active:not(:disabled) { transform: translateY(0); }
    .btn:disabled { opacity: 0.42; cursor: default; pointer-events: none; }

    .btn-icon {
      padding: 6px 8px;
    }

    .btn.accent {
      background: linear-gradient(160deg, #1ea5c7 0%, #0e7490 100%);
      border-color: rgba(14,116,144,0.9);
      color: #e0f7ff;
      box-shadow: 0 1px 4px rgba(14,116,144,0.35);
    }
    .btn.accent:hover:not(:disabled) {
      background: linear-gradient(160deg, #26b5d8 0%, #138fa9 100%);
      box-shadow: 0 3px 10px rgba(14,116,144,0.4);
    }
    .btn.danger {
      background: linear-gradient(160deg, #c22c27 0%, #8f1e1a 100%);
      border-color: rgba(143,30,26,0.8);
      color: #ffd6d4;
      box-shadow: 0 1px 4px rgba(143,30,26,0.35);
    }
    .btn.danger:hover:not(:disabled) {
      background: linear-gradient(160deg, #d83632 0%, #a3231f 100%);
    }
    .btn.clone {
      background: linear-gradient(160deg, #238c68 0%, #155c45 100%);
      border-color: rgba(21,92,69,0.8);
      color: #c8ffe9;
      box-shadow: 0 1px 4px rgba(21,92,69,0.35);
    }
    .btn.clone:hover:not(:disabled) {
      background: linear-gradient(160deg, #2aa878 0%, #1a7055 100%);
    }
    .btn.ghost {
      background: transparent;
      border-color: var(--c-border);
      color: var(--c-muted);
    }
    .btn.ghost:hover:not(:disabled) {
      color: var(--c-text);
      border-color: rgba(99,118,140,0.7);
      background: rgba(255,255,255,0.05);
    }

    /* ── Account grid ─────────────────────────────────────────────── */
    .accounts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 10px;
    }

    /* ── Account card ─────────────────────────────────────────────── */
    .account-card {
      position: relative;
      background: var(--c-surface-2);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-lg);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: var(--shadow-card);
      transition: box-shadow 180ms var(--ease), border-color 180ms var(--ease), transform 180ms var(--ease);
      animation: fadeUp 250ms var(--ease) both;
    }
    .account-card:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.3);
    }
    .account-card.active {
      border-color: rgba(30,165,199,0.5);
      box-shadow: var(--shadow-active);
    }

    /* active strip */
    .account-card.active::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      background: linear-gradient(90deg, var(--c-accent), transparent);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }
    .card-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }

    .account-avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1c3a4a, #0d2233);
      border: 1px solid var(--c-border);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--c-accent);
      text-transform: uppercase;
    }

    .account-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--c-text);
      overflow-wrap: anywhere;
      line-height: 1.3;
    }
    .account-handle {
      font-size: 11.5px;
      color: var(--c-muted);
      overflow-wrap: anywhere;
    }

    .card-badges {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 2px 8px;
      border: 1px solid transparent;
    }
    .badge.active {
      background: rgba(30,165,199,0.14);
      border-color: rgba(30,165,199,0.45);
      color: #79c8e8;
    }
    .badge.valid {
      background: rgba(63,185,80,0.12);
      border-color: rgba(63,185,80,0.38);
      color: #7ee787;
    }
    .badge.expired {
      background: rgba(248,81,73,0.12);
      border-color: rgba(248,81,73,0.38);
      color: #ff8a80;
    }
    .badge.unknown {
      background: rgba(125,143,160,0.12);
      border-color: rgba(125,143,160,0.32);
      color: var(--c-muted);
    }

    /* ── Card actions ─────────────────────────────────────────────── */
    .card-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      padding-top: 4px;
      border-top: 1px solid var(--c-border);
    }
    .card-actions .btn { font-size: 11.5px; padding: 5px 10px; }

    /* ── Empty state ──────────────────────────────────────────────── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 36px 20px;
      text-align: center;
      border: 1px dashed rgba(48,54,61,0.8);
      border-radius: var(--radius-lg);
      background: var(--c-surface-2);
      color: var(--c-muted);
    }
    .empty-icon {
      width: 42px; height: 42px;
      border-radius: 50%;
      background: rgba(30,165,199,0.1);
      border: 1px solid rgba(30,165,199,0.22);
      display: flex; align-items: center; justify-content: center;
    }
    .empty-icon svg { width: 20px; height: 20px; fill: var(--c-accent); opacity: 0.7; }
    .empty-state h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--c-text);
    }
    .empty-state p { font-size: 12px; max-width: 280px; }

    /* ── Divider ──────────────────────────────────────────────────── */
    .section-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--c-muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--c-border);
    }

    /* ── Animations ───────────────────────────────────────────────── */
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Responsive ───────────────────────────────────────────────── */
    @media (max-width: 480px) {
      body { padding: 8px; }
      .topbar { padding: 12px; }
      .content { padding: 12px; }
      .card-actions { flex-direction: column; }
      .card-actions .btn { width: 100%; justify-content: center; }
      .form-row { flex-direction: column; }
      .form-row .btn { width: 100%; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- Top bar -->
    <header class="topbar">
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        </div>
        <div class="brand-text">
          <span class="brand-name">GHAS</span>
          <span class="brand-sub">GitHub Account Switcher</span>
        </div>
      </div>
      <div class="toolbar">
        <button id="btn-add-account" class="btn accent">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zm1 7V4H7v3H4v2h3v3h2V9h3V7H9z"/></svg>
          Add Account
        </button>
        <button data-action="refreshList" class="btn ghost btn-icon" title="Refresh list">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
          Refresh
        </button>
      </div>
    </header>

    <!-- Content -->
    <section class="content">
      ${noticeHtml}

      <!-- Inline Add-Account form -->
      <div id="add-account-form" class="add-form" hidden>
        <div class="add-form-title">New Account</div>
        <div class="field">
          <label for="account-label-input" class="field-label">Account Label</label>
          <input
            id="account-label-input"
            type="text"
            class="field-input"
            placeholder="e.g. Personal, Work, Client…"
            maxlength="80"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="form-row">
          <button id="btn-submit-add" class="btn accent">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Sign in with GitHub
          </button>
          <button id="btn-cancel-add" class="btn ghost">Cancel</button>
        </div>
      </div>

      <!-- Accounts -->
      <section class="accounts-grid">
        ${accountsHtml}
      </section>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let busy = false;

    const addForm    = document.getElementById('add-account-form');
    const labelInput = document.getElementById('account-label-input');
    const btnAdd     = document.getElementById('btn-add-account');
    const btnSubmit  = document.getElementById('btn-submit-add');
    const btnCancel  = document.getElementById('btn-cancel-add');

    function openAddForm() {
      addForm.hidden = false;
      btnAdd.hidden  = true;
      labelInput.value = '';
      labelInput.focus();
    }
    function closeAddForm() {
      addForm.hidden = false;
      addForm.hidden = true;
      btnAdd.hidden  = false;
    }

    btnAdd.addEventListener('click', () => { if (!busy) openAddForm(); });

    btnCancel.addEventListener('click', closeAddForm);

    btnSubmit.addEventListener('click', () => {
      const label = labelInput.value.trim();
      if (!label) { labelInput.focus(); return; }
      closeAddForm();
      setBusy(true);
      vscode.postMessage({ type: 'add', label });
    });

    labelInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  btnSubmit.click();
      if (e.key === 'Escape') closeAddForm();
    });

    function setBusy(on) {
      busy = on;
      document.querySelectorAll('button').forEach(b => { b.disabled = on; });
    }

    document.addEventListener('click', event => {
      const el = event.target;
      if (!(el instanceof Element)) return;

      const button = el.closest('button[data-action]');
      if (!(button instanceof HTMLButtonElement) || busy) return;

      const action    = button.getAttribute('data-action');
      const accountId = button.getAttribute('data-account-id') || undefined;
      if (!action) return;

      if (action === 'delete') {
        const title = button.closest('.account-card')?.querySelector('.account-title')?.textContent?.trim();
        if (!window.confirm(title ? 'Remove "' + title + '" from GHAS?' : 'Remove this account?')) return;
      }

      setBusy(true);
      vscode.postMessage({ type: action, accountId });
    });
  </script>
</body>
</html>`;
}

function describeTokenState(tokenExpiry?: number): { kind: 'valid' | 'expired' | 'unknown'; label: string } {
  // No expiry stored means the token was added without an artificial expiry — show as valid/saved
  if (!tokenExpiry) {
    return { kind: 'valid', label: 'Token saved' };
  }

  const now = Date.now();
  if (tokenExpiry <= now) {
    return { kind: 'expired', label: 'Token expired — refresh to update' };
  }

  const remainingMs = tokenExpiry - now;
  const minutes = Math.ceil(remainingMs / (60 * 1000));
  if (minutes < 60) {
    return { kind: 'valid', label: `Valid for ${minutes} min` };
  }

  const hours = Math.ceil(minutes / 60);
  return { kind: 'valid', label: `Valid for ${hours} hr` };
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
