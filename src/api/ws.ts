import { WebSocketServer, type ServerOptions, type WebSocket } from 'ws';

/**
 * Stub `snapshot` payload shape from contracts/websocket-events.md. Real
 * panel/zone state isn't wired up until later phases (T029 feeds this same
 * shape from live repositories via src/api/ws-broadcaster.ts) — this
 * skeleton only guarantees a `snapshot` is sent immediately on connect.
 */
function buildSnapshot(): Record<string, unknown> {
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
export function registerConnectionHandlers(wss: WebSocketServer): void {
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
 * happens in the process bootstrap wiring, out of scope until a later task.
 */
export function createWebSocketServer(options: ServerOptions): WebSocketServer {
  const wss = new WebSocketServer(options);
  registerConnectionHandlers(wss);
  return wss;
}
