import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDaemon } from '../stores/daemon';

type RegisterOutcome =
  | { kind: 'running' }
  | { kind: 'requires_approval' }
  | { kind: 'not_found' }
  | { kind: 'error'; error: string };

type DaemonStatus =
  | { kind: 'not_registered' }
  | { kind: 'enabled' }
  | { kind: 'requires_approval' }
  | { kind: 'not_found' }
  | { kind: 'unknown' };

type ScreenState =
  | { kind: 'checking' }
  | { kind: 'first_run' }
  | { kind: 'legacy_upgrade' }
  | { kind: 'disabled' }
  | { kind: 'tampered' }
  | { kind: 'working' }
  | { kind: 'error'; message: string };

const LOGIN_ITEMS_URL =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

export default function SetupRequired() {
  const [state, setState] = useState<ScreenState>({ kind: 'checking' });

  useEffect(() => {
    void detectInitialState().then(setState);
  }, []);

  if (state.kind === 'checking') {
    return <Centered title="Checking installation…" />;
  }

  if (state.kind === 'first_run') {
    return (
      <Centered
        title="Enable FocusLock's background service"
        body="FocusLock needs to register a small background service so blocks survive UI close, force-quit, crash, and reboot. macOS will ask for your password once."
        action={{
          label: 'Enable background service',
          onClick: () => runRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'legacy_upgrade') {
    return (
      <Centered
        title="Upgrading FocusLock"
        body="FocusLock is moving its background service inside the app bundle. macOS will ask for your password once to clean up the old install."
        action={{
          label: 'Continue',
          onClick: () => runLegacyCleanupThenRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'disabled') {
    return (
      <Centered
        title="Background service is turned off"
        body="Open System Settings → Login Items & Extensions, find FocusLock under Allow in the Background, and turn it on."
        action={{
          label: 'Open System Settings',
          onClick: () => {
            window.location.href = LOGIN_ITEMS_URL;
          },
        }}
        secondary={{
          label: 'Try again',
          onClick: () => runRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'tampered') {
    return (
      <Centered
        title="Can't verify FocusLock's background service"
        body="The background service binary doesn't match its signature. Please reinstall FocusLock from the official source."
        action={{
          label: 'Open tryfocuslock.com',
          onClick: () => window.open('https://tryfocuslock.com', '_blank'),
        }}
      />
    );
  }

  if (state.kind === 'working') {
    return <Centered title="Setting up…" />;
  }

  return (
    <Centered
      title="Something went wrong"
      body={state.message}
      action={{
        label: 'Try again',
        onClick: () => runRegister(setState),
      }}
    />
  );
}

async function detectInitialState(): Promise<ScreenState> {
  try {
    const legacy = await invoke<boolean>('legacy_install_present_macos');
    if (legacy) return { kind: 'legacy_upgrade' };

    const raw = await invoke<string>('daemon_status_macos');
    const status = JSON.parse(raw) as DaemonStatus;
    if (status.kind === 'requires_approval') return { kind: 'disabled' };
    if (status.kind === 'not_found') return { kind: 'tampered' };
    return { kind: 'first_run' };
  } catch (e) {
    return { kind: 'error', message: String(e) };
  }
}

async function runRegister(setState: (s: ScreenState) => void) {
  setState({ kind: 'working' });
  try {
    const raw = await invoke<string>('install_daemon');
    const outcome = JSON.parse(raw) as RegisterOutcome;
    if (outcome.kind === 'running') {
      await useDaemon.getState().init();
      return;
    }
    if (outcome.kind === 'requires_approval') {
      setState({ kind: 'disabled' });
      return;
    }
    if (outcome.kind === 'not_found') {
      setState({ kind: 'tampered' });
      return;
    }
    setState({ kind: 'error', message: outcome.error });
  } catch (e) {
    setState({ kind: 'error', message: String(e) });
  }
}

async function runLegacyCleanupThenRegister(setState: (s: ScreenState) => void) {
  setState({ kind: 'working' });
  try {
    await invoke<void>('cleanup_legacy_install_macos');
  } catch (e) {
    setState({ kind: 'error', message: `Legacy cleanup failed: ${String(e)}` });
    return;
  }
  await runRegister(setState);
}

function Centered(props: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center p-8">
      <div className="max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold">{props.title}</h1>
        {props.body && (
          <p className="text-base opacity-80 leading-relaxed">{props.body}</p>
        )}
        {props.action && (
          <button
            onClick={props.action.onClick}
            className="rounded-md bg-white/10 px-5 py-2.5 font-medium hover:bg-white/20"
          >
            {props.action.label}
          </button>
        )}
        {props.secondary && (
          <button
            onClick={props.secondary.onClick}
            className="block w-full text-sm opacity-70 hover:opacity-100"
          >
            {props.secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}
