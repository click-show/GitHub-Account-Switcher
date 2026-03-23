# GHAS Account Manager UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a professional GHAS in-editor UI that makes add, switch, refresh, and delete account operations fast and clear.

**Architecture:** Add a dedicated webview command (`GHAS: Open Account Manager`) that renders saved accounts as action cards. Webview messages call backend account operations in `extension.ts`, then refresh the UI and status banner.

**Tech Stack:** VS Code extension API (`vscode`), TypeScript, webview HTML/CSS/JS in `extension.ts`.

---

### Task 1: Add GHAS Account Manager command and panel scaffold

**Files:**
- Modify: `extension.ts`
- Modify: `package.json`

**Step 1: Add command id and activation event**

- Add `ghasSwitcher.openManager` to command constants.
- Add `onCommand:ghasSwitcher.openManager` activation event.
- Add a contributed command title for Command Palette.

**Step 2: Register command and create panel**

- Register the command in `activate`.
- Create webview panel with scripts enabled and retained context.
- Add message handler for `refresh`, `add`, `switch`, `refreshToken`, `delete`.

**Step 3: Render initial HTML**

- Add `getManagerHtml` function and render it on panel open.
- Include empty-state and account list regions.

### Task 2: Connect UI actions to existing account logic

**Files:**
- Modify: `extension.ts`

**Step 1: Extract/introduce shared operation helpers**

- Add helpers to switch by account id, refresh by account id, delete by account id.
- Ensure operations update active account state.

**Step 2: Implement status + refresh cycle**

- After each action, refresh webview with latest accounts and a success/error banner.
- Keep existing command flows functional.

### Task 3: Improve UX polish and safety

**Files:**
- Modify: `extension.ts`

**Step 1: Professional styling**

- Add clear header, account cards, badges, and action buttons.
- Mobile/compact responsive layout.

**Step 2: Safe interactions**

- Confirm delete action before execution.
- Disable controls while action is running (in webview script).
- Escape account labels for HTML output.

### Task 4: Verification

**Files:**
- Modify: `extension.ts`
- Modify: `package.json`

**Step 1: Validate manifest JSON**

Run: `Get-Content package.json | ConvertFrom-Json | Out-Null`
Expected: no errors.

**Step 2: Static consistency checks**

Run: `rg -n "ghasSwitcher.openManager|openManager|onDidReceiveMessage|getManagerHtml" extension.ts package.json`
Expected: command IDs and handlers present.

**Step 3: Runtime smoke checklist (manual)**

1. Open `GHAS: Open Account Manager`.
2. Add account from UI.
3. Switch account from UI.
4. Refresh account from UI.
5. Delete account from UI.
6. Confirm list and status update after each action.
