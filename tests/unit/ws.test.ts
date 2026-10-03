import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createWebSocketServer } from '../../src/api/ws.js';

/**
 * The server sends `snapshot` synchronously in its `connection` handler, so
 * it can arrive before a test gets around to `await`-ing a fresh
 * `once(ws, 'message')` — that race would silently drop the event and hang
 * the test. Attaching a single `message` listener immediately (before the
 * handshake even completes) and queuing everything it sees avoids that.
 */
function collectMessages(ws: WebSocket): (index: number) => Promise<string> {
  const messages: string[] = [];
  const waiters: Array<() => void> = [];

  ws.on('message', (data) => {
    messages.push(data.toString());
    waiters.shift()?.();
  });

  return async (index: number): Promise<string> => {
    while (messages.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return messages[index]!;
  };
}

describe('ws push channel', () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = undefined;
    client = undefined;
  });

  async function connect(): Promise<{ ws: WebSocket; nextMessage: (index: number) => Promise<string> }> {
    wss = createWebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    const nextMessage = collectMessages(client);
    await once(client, 'open');
    return { ws: client, nextMessage };
  }

  it('sends a snapshot event immediately on connect', async () => {
    const { nextMessage } = await connect();
    const message = JSON.parse(await nextMessage(0));

    expect(message).toEqual({
      type: 'snapshot',
      panel: { mode: 'disarmed', pendingDelayEndsAt: null },
      zones: [],
    });
  });

  it('replies to a ping message with pong', async () => {
    const { ws, nextMessage } = await connect();
    await nextMessage(0); // discard the initial snapshot

    ws.send(JSON.stringify({ type: 'ping' }));

    expect(JSON.parse(await nextMessage(1))).toEqual({ type: 'pong' });
  });

  it('ignores malformed and unrecognized client messages without closing the connection', async () => {
    const { ws, nextMessage } = await connect();
    await nextMessage(0); // discard the initial snapshot

    ws.send('not json');
    ws.send(JSON.stringify({ type: 'unknown' }));
    ws.send(JSON.stringify({ type: 'ping' }));

    expect(JSON.parse(await nextMessage(1))).toEqual({ type: 'pong' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('sends an independent snapshot to each connecting client', async () => {
    const { nextMessage: firstNextMessage } = await connect();
    expect(JSON.parse(await firstNextMessage(0)).type).toBe('snapshot');

    const { port } = (wss as WebSocketServer).address() as AddressInfo;
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const secondNextMessage = collectMessages(second);
    await once(second, 'open');
    expect(JSON.parse(await secondNextMessage(0)).type).toBe('snapshot');

    second.close();
  });
});
