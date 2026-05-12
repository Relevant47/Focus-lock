use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::{
    Emitter, Manager,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_updater::UpdaterExt;

// ── Platform-specific IPC ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn ipc_call(request: &Value) -> Result<Value, String> {
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(r"\\.\pipe\focuslock")
        .map_err(|_| "Daemon not running".to_string())?;

    {
        let mut w = BufWriter::new(&pipe);
        let json = serde_json::to_string(request).map_err(|e| e.to_string())?;
        writeln!(w, "{json}").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }

    let mut reader = BufReader::new(&pipe);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(line.trim()).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn ipc_call(request: &Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect("/var/run/focuslock.sock")
        .map_err(|_| "Daemon not running".to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    {
        let mut w = BufWriter::new(&stream);
        let json = serde_json::to_string(request).map_err(|e| e.to_string())?;
        writeln!(w, "{json}").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }

    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(line.trim()).map_err(|e| e.to_string())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn ipc_request(request: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || ipc_call(&request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let _ = app.emit("update-available", update.version.clone());
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

// ── Tray helpers ──────────────────────────────────────────────────────────────

fn make_tray_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    // Solid indigo square — replace with a proper icon asset for production
    let rgba: Vec<u8> = (0..SIZE * SIZE).flat_map(|_| [99u8, 102u8, 241u8, 255u8]).collect();
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

fn session_label(status: &Value) -> String {
    if status.get("sessionActive").and_then(|v| v.as_bool()).unwrap_or(false) {
        let secs = status
            .get("secondsRemaining")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as u64;
        format!("⏱ {:02}:{:02} remaining", secs / 60, secs % 60)
    } else {
        "No active session".to_string()
    }
}

fn category_domains(cat: &str) -> &'static [&'static str] {
    match cat {
        "social_media" => &["instagram.com","tiktok.com","twitter.com","x.com","reddit.com","facebook.com","snapchat.com","linkedin.com","pinterest.com","tumblr.com","threads.net","bereal.com"],
        "streaming"    => &["youtube.com","netflix.com","twitch.tv","disneyplus.com","hbomax.com","max.com","hulu.com","primevideo.com","peacocktv.com","paramountplus.com","crunchyroll.com","spotify.com","soundcloud.com"],
        "gaming"       => &["store.steampowered.com","steamcommunity.com","epicgames.com","battle.net","origin.com","ea.com","xbox.com","gog.com","itch.io"],
        "news"         => &["cnn.com","bbc.com","bbc.co.uk","news.ycombinator.com","theguardian.com","nytimes.com","washingtonpost.com","foxnews.com","nbcnews.com","cbsnews.com","apnews.com","reuters.com","huffpost.com","buzzfeed.com"],
        "adult"        => &["pornhub.com","xvideos.com","xnxx.com","onlyfans.com","chaturbate.com","cam4.com","myfreecams.com"],
        _ => &[],
    }
}

fn build_tray_menu(app: &tauri::AppHandle, status_label: &str) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let show_item   = MenuItemBuilder::with_id("show",   "Open FocusLock").build(app)?;
    let status_item = MenuItemBuilder::with_id("status", status_label).enabled(false).build(app)?;
    let quit_item   = MenuItemBuilder::with_id("quit",   "Quit").build(app)?;

    let profiles_result = tokio::task::block_in_place(|| ipc_call(&json!({"type": "get_profiles"})));

    let mut builder = MenuBuilder::new(app)
        .item(&show_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&status_item)
        .item(&PredefinedMenuItem::separator(app)?);

    if let Ok(resp) = profiles_result {
        if let Some(arr) = resp.get("payload").and_then(|p| p.as_array()) {
            if !arr.is_empty() {
                let mut sub = SubmenuBuilder::new(app, "Quick Start");
                for profile in arr.iter().take(8) {
                    let id       = profile.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name     = profile.get("name").and_then(|v| v.as_str()).unwrap_or("Profile").to_string();
                    let duration = profile.get("defaultDurationMinutes").and_then(|v| v.as_u64()).unwrap_or(25);
                    let item     = MenuItemBuilder::with_id(format!("profile_{id}"), format!("{name} ({duration}m)")).build(app)?;
                    sub = sub.item(&item);
                }
                builder = builder
                    .item(&sub.build()?)
                    .item(&PredefinedMenuItem::separator(app)?);
            }
        }
    }

    builder.item(&quit_item).build()
}

// ── Main entry point ──────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // ── System tray ──────────────────────────────────────────────────
            let initial_menu = build_tray_menu(app.handle(), "No active session")
                .unwrap_or_else(|_| {
                    MenuBuilder::new(app)
                        .item(&MenuItemBuilder::with_id("show", "Open FocusLock").build(app).unwrap())
                        .item(&PredefinedMenuItem::separator(app).unwrap())
                        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app).unwrap())
                        .build()
                        .unwrap()
                });

            TrayIconBuilder::with_id("main-tray")
                .icon(make_tray_icon())
                .menu(&initial_menu)
                .show_menu_on_left_click(false)
                .tooltip("FocusLock")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        id if id.starts_with("profile_") => {
                            let profile_id = id.trim_start_matches("profile_").to_string();
                            if let Ok(resp) = ipc_call(&json!({"type": "get_profiles"})) {
                                if let Some(profiles) = resp.get("payload").and_then(|p| p.as_array()) {
                                    if let Some(p) = profiles.iter().find(|p| {
                                        p.get("id").and_then(|v| v.as_str()) == Some(&profile_id)
                                    }) {
                                        let duration = p.get("defaultDurationMinutes").and_then(|v| v.as_u64()).unwrap_or(25);
                                        let cats     = p.get("blockedCategories").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                                        let custom   = p.get("customBlockedDomains").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                                        let mut domains: Vec<Value> = cats.iter()
                                            .filter_map(|c| c.as_str())
                                            .flat_map(|cat| category_domains(cat))
                                            .map(|d| json!(d))
                                            .collect();
                                        domains.extend(custom);
                                        let _ = ipc_call(&json!({
                                            "type": "start_session",
                                            "payload": {
                                                "profileId": profile_id,
                                                "durationMinutes": duration,
                                                "blockedDomains": domains,
                                                "blockedProcesses": p.get("customBlockedProcesses").cloned().unwrap_or(json!([])),
                                                "allowlistedDomains": p.get("allowlistedDomains").cloned().unwrap_or(json!([])),
                                                "hardcoreMode": p.get("hardcoreMode").and_then(|v| v.as_bool()).unwrap_or(false),
                                                "pomodoroConfig": p.get("pomodoroConfig").cloned().unwrap_or(json!(null)),
                                            }
                                        }));
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // ── Close → hide to tray ─────────────────────────────────────────
            let win = app.get_webview_window("main").unwrap();
            let close_handle = handle.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = close_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            });

            // ── Daemon status polling ────────────────────────────────────────
            let poll_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u64 = 0;
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    tick += 1;

                    let payload = match tokio::task::spawn_blocking(|| {
                        ipc_call(&json!({"type": "get_status"}))
                    }).await {
                        Ok(Ok(v)) => v,
                        _ => json!(null),
                    };

                    // Rebuild tray menu every 5s to refresh status label + profiles
                    if tick % 5 == 0 {
                        if let Some(tray) = poll_handle.tray_by_id("main-tray") {
                            if let Ok(new_menu) = build_tray_menu(&poll_handle, &session_label(&payload)) {
                                let _ = tray.set_menu(Some(new_menu));
                            }
                        }
                    }

                    let _ = poll_handle.emit("daemon-status", payload);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc_request, check_for_updates])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
