export interface SuggestedApp {
  id: string;
  label: string;
  /** Windows ProcessName (no .exe). Matched case-insensitively by the daemon. */
  windowsProcess: string;
  /** macOS bundle identifier, when known. Resolved via NSWorkspace at kill time. */
  macBundleId?: string;
  /** Fallback macOS process name (matches `ps -o comm`) if no bundle ID known. */
  macProcess?: string;
  category: 'Gaming' | 'Social' | 'Productivity' | 'Streaming' | 'Other';
}

// Bundle IDs verified against current public app metadata. Where a Mac build
// doesn't exist (e.g. Battle.net macOS was discontinued for many regions) we
// still keep the entry — the Windows side benefits, and macOS users just see
// a chip that does nothing on their machine.
export const SUGGESTED_APPS: SuggestedApp[] = [
  // Gaming
  { id: 'steam',         label: 'Steam',                 windowsProcess: 'steam',           macBundleId: 'com.valvesoftware.steam',     category: 'Gaming' },
  { id: 'battlenet',     label: 'Battle.net',            windowsProcess: 'Battle.net',      macBundleId: 'net.battle.bootstrapper',     category: 'Gaming' },
  { id: 'epic',          label: 'Epic Games Launcher',   windowsProcess: 'EpicGamesLauncher', macBundleId: 'com.epicgames.EpicGamesLauncher', category: 'Gaming' },
  { id: 'riot',          label: 'Riot Client',           windowsProcess: 'RiotClientServices', macProcess: 'Riot Client',                category: 'Gaming' },
  { id: 'roblox',        label: 'Roblox',                windowsProcess: 'RobloxPlayerBeta', macBundleId: 'com.roblox.RobloxPlayer',     category: 'Gaming' },
  { id: 'minecraft',     label: 'Minecraft Launcher',    windowsProcess: 'MinecraftLauncher', macBundleId: 'com.mojang.minecraftlauncher', category: 'Gaming' },

  // Social / chat
  { id: 'discord',       label: 'Discord',               windowsProcess: 'Discord',         macBundleId: 'com.hnc.Discord',             category: 'Social' },
  { id: 'whatsapp',      label: 'WhatsApp',              windowsProcess: 'WhatsApp',        macBundleId: 'net.whatsapp.WhatsApp',       category: 'Social' },
  { id: 'telegram',      label: 'Telegram',              windowsProcess: 'Telegram',        macBundleId: 'ru.keepcoder.Telegram',       category: 'Social' },
  { id: 'signal',        label: 'Signal',                windowsProcess: 'Signal',          macBundleId: 'org.whispersystems.signal-desktop', category: 'Social' },

  // Productivity (work-time distractions)
  { id: 'slack',         label: 'Slack',                 windowsProcess: 'slack',           macBundleId: 'com.tinyspeck.slackmacgap',   category: 'Productivity' },

  // Streaming / media
  { id: 'spotify',       label: 'Spotify',               windowsProcess: 'Spotify',         macBundleId: 'com.spotify.client',          category: 'Streaming' },
  { id: 'obs',           label: 'OBS Studio',            windowsProcess: 'obs64',           macBundleId: 'com.obsproject.obs-studio',   category: 'Streaming' },
  { id: 'twitch',        label: 'Twitch desktop',        windowsProcess: 'Twitch',          macProcess: 'Twitch',                       category: 'Streaming' },
];
