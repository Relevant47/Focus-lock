import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDaemon } from '../stores/daemon';

type ScreenState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'error'; message: string };

export default function WindowsDaemonDisconnected() {
  const [state, setState] = useState<ScreenState>({ kind: 'idle' });

  if (state.kind === 'working') {
    return <Centered title="Restarting background service…" />;
  }

  if (state.kind === 'error') {
    return (
      <Centered
        title="Couldn't restart the background service"
        body={state.message}
        action={{
          label: 'Try again',
          onClick: () => runInstall(setState),
        }}
        secondary={{
          label: 'Open tryfocuslock.com',
          onClick: () => window.open('https://tryfocuslock.com', '_blank'),
        }}
      />
    );
  }

  return (
    <Centered
      title="FocusLock background service isn't running"
      body="FocusLock needs its background service to enforce blocks. This can happen after a restart, an update, or if the service was stopped manually. Windows will ask for administrator permission."
      action={{
        label: 'Restart background service',
        onClick: () => runInstall(setState),
      }}
    />
  );
}

async function runInstall(setState: (s: ScreenState) => void) {
  setState({ kind: 'working' });
  try {
    // Windows branch of install_daemon returns a bare string —
    // "started" / "already_running" / "installed" — not JSON. We don't
    // need to parse it: any non-throw means the service is up, so kick
    // the daemon store to reconnect.
    await invoke<string>('install_daemon');
    await useDaemon.getState().init();
  } catch (e) {
    setState({ kind: 'error', message: String(e) });
  }
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
