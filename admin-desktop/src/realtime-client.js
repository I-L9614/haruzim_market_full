// Drop-in replacement for the socket.io-client usage in admin-desktop/src/main.jsx.
// Connects to the Cloudflare Worker's Durable-Object realtime endpoint.
// Token travels as a WebSocket subprotocol (never in the URL).
//
// Migration in main.jsx:
//   1. Replace:  import { io } from 'socket.io-client';
//      With:     import { connectRealtime } from './realtime-client';
//   2. Replace:  const socket = io(SOCKET_URL, { auth: { token } });
//      With:     const socket = connectRealtime(SOCKET_URL, token);
//   3. Remove "socket.io-client" from package.json dependencies.
// The socket.on(...) handlers stay exactly the same: 'connect', 'disconnect',
// 'newOrder', 'orderUpdated'. Reconnect is automatic with backoff.

export function connectRealtime(socketUrl, token) {
  const wsUrl = socketUrl.replace(/^http/, 'ws') + '/realtime';
  const handlers = new Map();
  let ws = null;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer = null;

  const emit = (event, payload) => {
    for (const handler of handlers.get(event) || []) {
      try { handler(payload); } catch { /* handler errors must not kill the socket loop */ }
    }
  };

  const connect = () => {
    if (closedByUser) return;
    ws = new WebSocket(wsUrl, ['bearer', token]);
    ws.onopen = () => { attempt = 0; emit('connect'); };
    ws.onmessage = (message) => {
      try {
        const { event, payload } = JSON.parse(message.data);
        if (event) emit(event, payload);
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      emit('disconnect');
      if (closedByUser) return;
      const delay = Math.min(30000, 1000 * 2 ** attempt++);
      reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  };

  connect();

  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    disconnect() {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* already closed */ }
    }
  };
}
