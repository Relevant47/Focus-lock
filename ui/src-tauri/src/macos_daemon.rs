//! macOS daemon registration via SMAppService, bridged through a
//! tiny Swift static library (`swift-bridge/`).

#![cfg(target_os = "macos")]

use swift_rs::{swift, SRString};

swift!(fn focuslock_sm_register() -> i32);
swift!(fn focuslock_sm_status() -> i32);
swift!(fn focuslock_sm_unregister() -> i32);
swift!(fn focuslock_sm_last_error() -> SRString);

/// Keep in sync with SMBridge.swift constants.
const OK_RUNNING_OR_PENDING: i32 = 0;
const REQUIRES_APPROVAL: i32 = 1;
const NOT_FOUND: i32 = 2;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegisterOutcome {
    /// SMAppService reports the service is registered. The socket may
    /// not have appeared yet — caller should poll briefly.
    Running,
    /// User must approve in System Settings → Login Items (or denied
    /// the initial prompt). UI should route to the "disabled" screen.
    RequiresApproval,
    /// The bundled plist couldn't be found inside the .app — almost
    /// certainly a broken install. UI should show "reinstall" guidance.
    NotFound,
    /// Anything else. `error` is the macOS-supplied description.
    Error { error: String },
}

pub fn register_and_start() -> RegisterOutcome {
    let code = unsafe { focuslock_sm_register() };
    match code {
        c if c == OK_RUNNING_OR_PENDING => RegisterOutcome::Running,
        c if c == REQUIRES_APPROVAL => RegisterOutcome::RequiresApproval,
        c if c == NOT_FOUND => RegisterOutcome::NotFound,
        _ => {
            let err = unsafe { focuslock_sm_last_error() };
            RegisterOutcome::Error { error: err.to_string() }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServiceStatus {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
    Unknown,
}

pub fn status() -> ServiceStatus {
    match unsafe { focuslock_sm_status() } {
        0 => ServiceStatus::NotRegistered,
        1 => ServiceStatus::Enabled,
        2 => ServiceStatus::RequiresApproval,
        3 => ServiceStatus::NotFound,
        _ => ServiceStatus::Unknown,
    }
}

/// Best-effort unregister. Used only by the legacy-cleanup flow.
pub fn unregister() -> bool {
    unsafe { focuslock_sm_unregister() == 0 }
}

/// One-time cleanup of the pre-SMAppService install paths.
/// Runs an `osascript` shell-out with admin privileges, which the
/// user authorizes once. Idempotent — safe to run when nothing exists.
pub fn cleanup_legacy_install() -> Result<(), String> {
    let script = r#"do shell script "
launchctl bootout system/com.focuslock.daemon 2>/dev/null || true
launchctl unload /Library/LaunchDaemons/com.focuslock.daemon.plist 2>/dev/null || true
rm -f /Library/PrivilegedHelperTools/FocusLockDaemon
rm -f /Library/LaunchDaemons/com.focuslock.daemon.plist
rmdir /Library/PrivilegedHelperTools 2>/dev/null || true
rm -f /Library/Application\\ Support/FocusLock/daemon.hash
" with administrator privileges"#;

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "legacy cleanup failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Returns true if any legacy install artifact exists on disk.
/// Read-only — does NOT require admin.
pub fn legacy_install_present() -> bool {
    use std::path::Path;
    Path::new("/Library/PrivilegedHelperTools/FocusLockDaemon").exists()
        || Path::new("/Library/LaunchDaemons/com.focuslock.daemon.plist").exists()
        || Path::new("/Library/Application Support/FocusLock/daemon.hash").exists()
}
