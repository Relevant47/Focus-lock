# Parental Controls — UI Walkthrough

A click-by-click verification script for the parental-controls + audit-log + email-recovery features. The daemon is already running the new build (rebuilt earlier in the session). The UI bundle in `ui/dist/` has the new code but the running app might still be the old bundle — see step 0.

## 0. Start the UI against the live daemon

```
cd ui
npm run tauri dev
```

This opens the FocusLock app pointed at the running `FocusLockDaemon` service. Wait until you see the dashboard load with normal data.

> **If you'd rather test the production-style bundle**, run `npm run tauri build` and reinstall. Dev mode is faster for iteration.

---

## Section A — PIN setup (no recovery email)

**Goal:** confirm the PIN flow works without binding an email.

1. Navigate to **Settings**.
2. Scroll to **Parent controls**. Expected state:
   - Row label: "No parent PIN set"
   - Pill: "Off" (neutral)
   - Single button: "Set up parent PIN"
3. Click **Set up parent PIN**. Expected: form expands with two PIN fields and an optional email field.
4. Type PIN `1234` in both fields. Leave email blank.
5. Click **Set PIN**. Expected:
   - Form collapses back to the idle view
   - Row label: "Parent PIN configured"
   - Sub-text: "Sensitive commands are gated. No recovery email bound."
   - Pill: "On" (green)
   - Success message: "Parent PIN set. Sensitive actions now require it. (No recovery email…)"

**❗ If the success message shows but the row doesn't update**, the status hasn't refreshed yet. Wait ~1s or navigate away and back.

---

## Section B — Unlock modal appears on gated action

**Goal:** confirm the gate fires when you try a sensitive action.

1. Navigate to **Profiles**.
2. Click any profile to edit it (or create a new one), make a trivial change, and click **Save**.
3. Expected: the **Parent PIN required** modal appears centered, with:
   - Lock icon + heading
   - "Enter the parent PIN…" body text, mentioning "5 minutes"
   - PIN input (focused)
   - Cancel + Unlock buttons
   - **No** "Forgot PIN?" link (we didn't bind an email)

4. Type the wrong PIN (`9999`) and click **Unlock**. Expected:
   - Red error: "Incorrect PIN"
   - The input stays open for retry

5. Type 3–4 more wrong PINs in a row. Expected: at some point you'll see "Rate limited — wait Ns" with a countdown. The "Unlock" button is disabled.

6. Wait the indicated time (or close + reopen the app to skip — the rate-limit lives in daemon memory for the process lifetime).

7. Type the correct PIN `1234` and click **Unlock**. Expected:
   - Modal closes
   - Your original profile save completes (look for the profile list reflecting your change)

---

## Section C — Recent activity panel

**Goal:** confirm the audit panel appears after unlock and shows entries.

1. Stay in Settings → Parent Controls. With the PIN still verified (within 5 min), you should see a new **Recent activity** section at the bottom of the Parent Controls card.
2. Expected entries (newest first):
   - `Command allowed` `save_profile` — your successful save
   - `Command allowed` `get_parent_audit` — the read itself (gated)
   - `Unlock — success` — your correct PIN
   - `Unlock — wrong PIN` (×4 or so) — your failed attempts
   - `Unlock — rate limited` — if you hit the limit
   - `PIN configured` — initial setup

3. Click **Refresh**. Expected: list reloads, may add a new `Command allowed get_parent_audit` entry at the top.

4. Wait 5 minutes (or skip to next step). After the grace window expires, **Recent activity** should disappear from the panel — the gate re-engages.

---

## Section D — Change PIN

**Goal:** confirm the change-PIN flow.

1. Settings → Parent Controls → **Change PIN**.
2. Expected: form shows three fields — Current PIN, New PIN, Confirm PIN. No email field here (change is for PIN only).
3. Enter Current = `1234`, New = `5678`, Confirm = `5678`. Click **Update PIN**.
4. Expected: form collapses, success message "Parent PIN updated."
5. Trigger a gated action again (edit a profile). Old PIN `1234` should fail; new PIN `5678` should succeed.

---

## Section E — Recovery key (shown once at setup)

**Goal:** confirm that PIN setup generates and reveals the recovery key correctly.

1. First remove the current PIN if one is set: Settings → Parent Controls → **Remove PIN** → enter current PIN → confirm. State returns to "Off".
2. Click **Set up parent PIN** again. Enter PIN `1234` / `1234` and click **Set PIN**.
3. Expected: a yellow-bordered card appears with:
   - "Recovery key — save this now" heading
   - A 16-character key formatted like `XXXX-XXXX-XXXX-XXXX` in large monospace
   - Copy button
   - "I've saved it" button
4. Click **Copy**. Expected: button changes to "Copied" briefly. Paste somewhere to verify the value (then erase from clipboard).
5. **Save the key** somewhere real (password manager, sticky note, whatever).
6. Click **I've saved it**. Expected: the reveal card disappears, success message remains.

---

## Section F — Recovery (clearing PIN with the saved key)

**Goal:** confirm the recovery-key path actually clears the PIN.

1. Trigger any gated action (e.g. edit a profile). Unlock modal appears.
2. Click **Use recovery key** at bottom-left. Modal swaps to a key-entry view.
3. Try a wrong key first (e.g. `XXXX-YYYY-ZZZZ-WWWW`). Expected: red "Incorrect recovery key" error.
4. Enter the real key (with or without hyphens, case doesn't matter). Click **Clear PIN**.
5. Expected:
   - Modal closes
   - Your original gated action proceeds
   - Settings shows "No parent PIN set" — the PIN was cleared entirely

---

## Section G — Regenerate recovery key

**Goal:** confirm the recovery key can be rotated.

1. Set up a fresh PIN with a known recovery key (Section E). Save it.
2. Settings → Parent Controls → **New recovery key**.
3. Expected: form shows "Current PIN" field with warning about invalidating the old key.
4. Enter the current PIN, click **Generate new key**.
5. Expected: a new key is revealed in the same yellow card. The old key no longer works.
6. **Verify:** open the unlock modal, try the old key → "Incorrect recovery key". Try the new key → PIN cleared.

---

## What to report back

For each section, tell me:
- **Worked as described** ✓
- **Worked but with X** (describe deviation)
- **Broke at step N** (paste the error + screenshot if possible)
- **Didn't try this** (e.g. skipping recovery if no server deploy)

I'll be especially curious about:
- Visual polish issues (alignment, spacing, color)
- Any case where the modal stays open after success
- Whether the audit log entries match what you'd expect to see
- Timing/animation rough edges
