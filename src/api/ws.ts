import { WebSocketServer, type ServerOptions, type WebSocket } from 'ws';

/**
 * Stub `snapshot` payload shape from contracts/websocket-events.md, used when
 * no real `buildSnapshot` is supplied (e.g. `tests/unit/ws.test.ts`
 * exercising just the protocol skeleton). `src/api/ws-broadcaster.ts` (T029)
 * supplies the real one, built from live panel/zone state.
 */
function stubSnapshot(): Record<string, unknown> {
  return {
    type: 'snapshot',
    panel: { mode: 'disarmed', pendingDelayEndsAt: null },
    zones: [],
  };
}

/**
 * The only documented client -> server message is a periodic `ping` for
 * liveness (contracts/websocket-events.md), sent as a JSON envelope like
 * every other message on this channel: `{ "type": "ping" }`.
 */
function isPingMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ping';
}

/**
 * Wires the push-channel protocol onto an already-constructed
 * `WebSocketServer`: send `snapshot` immediately on connect, and reply to a
 * `ping` message with `pong`. Malformed/unrecognized client messages are
 * ignored rather than closing the connection — this channel is read-only
 * (all commands go through the REST API per the contract), so there's no
 * other message type to validate against yet.
 *
 * Reconnect/resync semantics (forcing a fresh `snapshot` after a drop) are
 * explicitly out of scope here — that's T034, once real state exists to
 * resync from.
 */
export function registerConnectionHandlers(wss: WebSocketServer, buildSnapshot: () => Record<string, unknown> = stubSnapshot): void {
  wss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify(buildSnapshot()));

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (isPingMessage(parsed)) {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
  });
}

/**
 * Constructs a `WebSocketServer` with the push-channel protocol already
 * wired up. Takes `ws`'s own `ServerOptions` (e.g. `{ server: httpServer,
 * path: '/api/v1/stream' }` to share the REST API's HTTP server, or
 * `{ port }` for standalone use in tests) rather than opening a port
 * itself — attaching this to the actual HTTP server from src/api/app.ts
 * happens in the process bootstrap wiring.
 *
 * `buildSnapshot`, when supplied, replaces the stub snapshot with one backed
 * by live state — `src/api/ws-broadcaster.ts` (T029) is the real caller that
 * supplies it from `PanelService`/`ZoneRepository`; tests exercising just the
 * protocol skeleton can omit it.
 */
export function createWebSocketServer(options: ServerOptions, buildSnapshot?: () => Record<string, unknown>): WebSocketServer {
  const wss = new WebSocketServer(options);
  registerConnectionHandlers(wss, buildSnapshot);
  return wss;
}
