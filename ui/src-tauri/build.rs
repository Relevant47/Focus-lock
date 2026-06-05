fn main() {
    #[cfg(target_os = "macos")]
    {
        use swift_rs::SwiftLinker;
        SwiftLinker::new("13")
            .with_package("FocusLockSMBridge", "./swift-bridge")
            .link();

        bundle_macos_daemon();
    }

    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn bundle_macos_daemon() {
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let daemon_src = manifest_dir
        .join("..")
        .join("..")
        .join("daemon-mac")
        .join(".build")
        .join("release")
        .join("FocusLockDaemon");
    let plist_src = manifest_dir
        .join("..")
        .join("..")
        .join("daemon-mac")
        .join("com.focuslock.daemon.plist");

    let stage_dir = manifest_dir.join("target").join("daemon-stage");
    std::fs::create_dir_all(&stage_dir).expect("create stage dir");

    if daemon_src.exists() {
        let dest = stage_dir.join("FocusLockDaemon");
        std::fs::copy(&daemon_src, &dest).expect("copy daemon binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .expect("chmod daemon");
        }
    } else {
        println!(
            "cargo:warning=daemon binary not found at {} — run `cd daemon-mac && swift build -c release` first",
            daemon_src.display()
        );
    }

    if plist_src.exists() {
        std::fs::copy(&plist_src, stage_dir.join("com.focuslock.daemon.plist"))
            .expect("copy plist");
    } else {
        println!(
            "cargo:warning=plist not found at {}",
            plist_src.display()
        );
    }

    println!("cargo:rerun-if-changed={}", daemon_src.display());
    println!("cargo:rerun-if-changed={}", plist_src.display());
}
