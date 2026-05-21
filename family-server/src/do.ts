import type { Env } from './types';

/**
 * One Durable Object per device, named by device ID. Holds the live WebSocket
 * to the child daemon and accepts internal /notify pushes from the parent-side
 * REST routes when rules change.
 *
 * Single active WS per device — re-connecting replaces the old one (the kid
 * can't run two daemons to confuse us).
 *
 * Heartbeat-driven last_seen updates are throttled to 1/minute to avoid hot-
 * writing the devices table on every 60-second ping.
 */
export class DeviceConnection implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private ws: WebSocket | null = null;
  private deviceId: string | null = null;
  private lastDbWriteAt = 0;

  private static readonly LAST_SEEN_MIN_WRITE_INTERVAL_MS = 60_000;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/connect') {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      this.deviceId = url.searchParams.get('did');
      if (!this.deviceId) return new Response('missing did', { status: 400 });

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      // Boot any existing connection — at most one active WS per device.
      try { this.ws?.close(1000, 'replaced by new connection'); } catch { /* ignore */ }
      this.ws = server;

      server.addEventListener('message', (e: MessageEvent) => { this.onMessage(server, e); });
      server.addEventListener('close', () => { if (this.ws === server) this.ws = null; });
      server.addEventListener('error', () => { if (this.ws === server) this.ws = null; });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify') {
      const body = await req.text();
      if (!this.ws) return new Response('no client connected', { status: 503 });
      try { this.ws.send(body); } catch { return new Response('send failed', { status: 502 }); }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  private async onMessage(ws: WebSocket, e: MessageEvent): Promise<void> {
    if (typeof e.data !== 'string') return;
    let msg: { type?: unknown };
    try { msg = JSON.parse(e.data) as { type?: unknown }; } catch { return; }

    if (msg.type === 'heartbeat' && this.deviceId) {
      const now = Date.now();
      if (now - this.lastDbWriteAt > DeviceConnection.LAST_SEEN_MIN_WRITE_INTERVAL_MS) {
        this.lastDbWriteAt = now;
        // Fire-and-forget; DB lag shouldn't block the heartbeat ack.
        this.env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
          .bind(new Date(now).toISOString(), this.deviceId)
          .run()
          .catch((err: unknown) => console.warn('last_seen update failed', err));
      }
      try { ws.send(JSON.stringify({ type: 'ack', t: now })); } catch { /* ignore */ }
    }
  }
}
