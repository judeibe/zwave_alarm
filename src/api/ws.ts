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
 * Reconnect/resync (contracts/websocket-events.md's "resync after
 * reconnect" requirement, T034): a client reconnecting after a drop opens a
 * brand-new WebSocket, which is indistinguishable from a first-time
 * connect — it always lands here and gets a fresh `buildSnapshot()` first.
 * No buffering/ack handshake is needed to guarantee ordering ahead of
 * incremental broadcasts (`src/api/ws-broadcaster.ts`): `socket.send` runs
 * synchronously as the first statement of this handler, and Node's
 * single-threaded event loop means no other code (including a broadcast
 * triggered by a concurrent REST call) can run between a client being
 * accepted and its snapshot being queued on the socket's write stream, which
 * then preserves call order for everything queued after it. A dropped
 * client is also removed from `wss.clients` (the `ws` library's own
 * `close`/error handling), so it never receives incremental events sent
 * while it was offline — verified by the reconnect test in
 * tests/unit/ws-broadcaster.test.ts.
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
