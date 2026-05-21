# Family Controls — closed beta

**Version this is for:** FocusLock v1.1.0 or later
**Goal:** find what breaks when a real parent–child pair actually uses this in daily life, before opening up to general availability.

---

## What this is

A parent on one machine can hard-lock specific apps and websites on a child's machine, at any time, from anywhere. Cloud sync in the middle, anti-bypass enforcement on the child side.

It is **not** a perfect cage — it's meaningful friction. A determined teenager with administrator rights, BIOS access, or a Linux USB will get around any pure-userspace product. FocusLock is honest about that and surfaces the load-bearing requirements directly in the parent dashboard.

## What this isn't

- Not the "Settings lock" feature from v1.0.26. That's single-device, locks **your own** settings against impulse-bypass.
- Not a content filter / web-categoriser. You block specific apps and domains by name; we don't ship a curated bad-internet list.
- Not GeoFi parental tracking, screen-time analytics, or anything similar.

## Who you ideally are

- One parent who's comfortable installing things on a Windows or macOS machine.
- One child (or shared child machine) you actually want to lock things on.
- Willing to put 30–60 minutes into setup and then 5 minutes to report back what worked and what didn't.

## What you need first — the one load-bearing setup step

> **Make the child's OS account a standard (non-administrator) account.**

Without this, every protection FocusLock ships can be bypassed in under a minute. The parent dashboard will warn you about this by name (it enumerates local administrators), but do it before pairing.

- **Windows:** Settings → Accounts → Family & other users → click the child's account → Change account type → Standard
- **macOS:** System Settings → Users & Groups → click the child's account → uncheck "Allow this user to administer this computer"

If the child only has an administrator account, create a new standard account for them first, move their stuff over, and demote the original.

## Setup

### Parent machine

1. Install FocusLock v1.1.0 (Windows or macOS — either works for the parent device).
2. Open the **Family** tab. Walk through the first-run modal — pick **I'm the parent**.
3. Create an account (email + password). You'll get a refreshable session token.
4. Click **Add device** — a 6-digit pairing code appears with a 10-minute expiry. Keep this screen open and walk over to the child's machine.

### Child machine

1. Install FocusLock v1.1.0.
2. Open the **Family** tab. Pick **This is the child's computer** when the walkthrough asks.
3. Enter the 6-digit code. Hit **Pair this device**. The page should switch to the "paired & online" view within a few seconds.

### Parent machine — finish up

5. Back on the parent dashboard, the device should appear in the **Paired devices** list with a green online dot.
6. Read the environment-warning banner carefully. If it lists any administrator accounts other than the daemon, follow the platform-specific instructions to demote them before going further.
7. Try a block: expand the device card, put `discord.exe` (or whichever app you want to test) in the **Apps** field, hit **Block on this device**. Within ~1 second on the child machine, that app should be unable to run / immediately killed if running.
8. Try a domain: put `reddit.com` in the **Domains** field. Reddit should be unreachable in the child's browser (hosts-file block).

### Optional hardening — set on the *child* machine

9. **Settings lock PIN.** From the child machine's Settings → Settings lock, set a 4-digit PIN you keep, save the recovery key. This gates unpair + the new "Allow uninstall" button, so a kid can't walk away from the lock without your PIN.
10. **Firewall lockdown (experimental).** From the child machine's Family tab, turn on the "Firewall lockdown" card. When the daemon's offline from our server for > 5 minutes, it'll apply per-app firewall blocks on Windows / per-IP pfctl blocks on macOS — useful if the kid tries to unplug the router.

## Things to test

We're especially interested in:

1. **Setup friction.** Where did you stumble? Was the walkthrough clear? Did the env-warning UI catch admin-account issues?
2. **Latency.** Roughly how long from "I clicked Block on this device" to the app actually being blocked on the child's machine? Aim is < 2 seconds; longer is a bug.
3. **Daily-life friction.** Once set up, did blocks fire correctly? Were there false positives (apps blocked you didn't expect)? Did the emergency-unblock button work when you needed it?
4. **Reconnect behaviour.** Put the child machine to sleep, wake it up — does it re-sync rules? Switch networks — does it reconnect within 30 seconds?
5. **Bypass attempts (if you have a willing kid).** Whatever attempts the kid actually tries, we want to know which ones we caught and which slipped through.

## Known limitations to expect

- **No mobile parent app.** Parent dashboard runs on a desktop machine only for v1.1.
- **No content categories.** You pick the specific apps + domains. The "social media / streaming / gaming" lists from regular FocusLock are not yet usable as family rule targets — coming.
- **No time-of-day schedule UI.** Schedule rules work in the daemon but the parent dashboard doesn't have a nice form yet — just block-now.
- **Cross-midnight schedules need two rules.** A "block 9pm to 6am weekdays" window can't be expressed in one cron pattern.
- **Password recovery is instant email reset.** If a kid briefly has access to the parent's email, they can reset the password. This is a known trade-off; we may add a 24h delay if abuse patterns emerge.
- **No 2FA on parent accounts yet.** Coming after the beta.
- **Firewall lockdown is opt-in and experimental.** Especially on macOS, it's per-IP (resolved from cached domain targets) rather than per-app — packet-layer complement to /etc/hosts, not a per-process binding.

## How to report

- **GitHub issues** for reproducible bugs: <https://github.com/Relevant47/focus-lock/issues>
- **Direct email** for anything you'd rather not put in public: me@oscarpetrikas.com
- **What helps most:** the platform (Windows / macOS), the version (Settings → Daemon shows it), exactly what you did, what you expected, what actually happened. Screenshots welcome.

## Privacy + data we hold

For the duration of the beta, our hosted family server stores:

- Your email address (parent account).
- A bcrypt hash of your password.
- One record per device you've paired (hostname, OS version, last-seen timestamp, account it's paired to).
- Each lock rule you've created.
- Audit-log lines on rule mutations.

We never see what's on the child's machine outside of which rules you've written. The daemon's own audit log (PIN attempts, daemon offline events, tamper detections) lives **only on the device** — it never leaves.

You can delete your account at any time (cascading delete of all devices, rules, logs). The full server is open-source under the same GPL repo as the app; if you'd rather self-host, you can.

## What happens after the beta

- We fix what you found.
- We open it up generally and start charging ~$5/mo per family for the hosted server. Single-device FocusLock stays free forever. Self-hosters keep the option to run their own family server and stay free that way too.
- The OSS license never changes.

Thanks for trying it. Genuinely, this is the part where finding what doesn't work matters more than anything else.

— Oscar
