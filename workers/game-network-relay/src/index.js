const MAX_ROOM_CLIENTS = 8;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MESSAGES_PER_10_SECONDS = 240;
const RATE_WINDOW_MS = 10_000;
const ROOM_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNELS = new Set(["control", "realtime", "sync"]);
const DASHBOARD_URL = "https://giuseppelevibo.github.io/game-network/";
const PUBLIC_RELAY_URL = "wss://game-network.giuseppe-levi.workers.dev/ws";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "game-network-relay",
        transport: "websocket",
      });
    }

    const shortInvite = createShortInviteRedirect(url);
    if (shortInvite) return shortInvite;

    if (url.pathname !== "/ws") {
      return new Response("Game Network Relay. Use /ws?room=ROOM-ID for WebSocket, /j/ROOM for guest links, or /h/ROOM for host links.", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json(
        {
          ok: false,
          error: "websocket_required",
          hint: "Connect with a WebSocket client to /ws?room=ROOM-ID.",
        },
        426,
      );
    }

    const roomId = sanitizeRoom(url.searchParams.get("room"));
    if (!roomId) {
      return json(
        {
          ok: false,
          error: "invalid_room",
          hint: "Use /ws?room=ROOM-ID with letters, numbers, dash or underscore.",
        },
        400,
      );
    }

    const objectId = env.ROOMS.idFromName(roomId);
    const room = env.ROOMS.get(objectId);
    return room.fetch(request);
  },
};

export class GameNetworkRoom {
  constructor(state) {
    this.state = state;
    this.clientsByPeerId = new Map();
    this.peerIdsBySocket = new Map();
    this.rateBySocket = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "websocket_required" }, 426);
    }

    if (this.clientsByPeerId.size >= MAX_ROOM_CLIENTS) {
      return json({ ok: false, error: "room_full", maxClients: MAX_ROOM_CLIENTS }, 429);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    server.addEventListener("message", (event) => this.handleMessage(server, event.data));
    server.addEventListener("close", () => this.removeSocket(server));
    server.addEventListener("error", () => this.removeSocket(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  handleMessage(socket, data) {
    if (typeof data !== "string") return;
    if (data.length > MAX_MESSAGE_BYTES) {
      this.closeSocket(socket, 1009, "message_too_large");
      return;
    }
    if (!this.allowMessage(socket)) {
      this.closeSocket(socket, 1008, "rate_limited");
      return;
    }

    const message = parseClientMessage(data);
    if (!message) return;

    if (message.kind === "register") {
      if (this.clientsByPeerId.has(message.peerId) && this.clientsByPeerId.get(message.peerId) !== socket) {
        this.closeSocket(socket, 1008, "peer_id_already_registered");
        return;
      }
      this.clientsByPeerId.set(message.peerId, socket);
      this.peerIdsBySocket.set(socket, message.peerId);
      send(socket, {
        kind: "registered",
        peerId: message.peerId,
      });
      return;
    }

    const fromPeerId = this.peerIdsBySocket.get(socket);
    if (!fromPeerId) return;

    if (message.kind === "signal") {
      const target = this.clientsByPeerId.get(message.toPeerId);
      if (target) {
        send(target, {
          kind: "signal",
          fromPeerId,
          toPeerId: message.toPeerId,
          payload: message.payload,
        });
      }
      return;
    }

    const outgoing = {
      kind: "transport",
      fromPeerId,
      toPeerId: message.toPeerId,
      channel: message.channel,
      data: message.data,
    };

    if (message.toPeerId) {
      const target = this.clientsByPeerId.get(message.toPeerId);
      if (target) send(target, outgoing);
      return;
    }

    for (const [peerId, client] of this.clientsByPeerId) {
      if (peerId !== fromPeerId) send(client, outgoing);
    }
  }

  allowMessage(socket) {
    const now = Date.now();
    const current = this.rateBySocket.get(socket);
    if (!current || now - current.startedAtMs > RATE_WINDOW_MS) {
      this.rateBySocket.set(socket, { startedAtMs: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= MAX_MESSAGES_PER_10_SECONDS;
  }

  removeSocket(socket) {
    const peerId = this.peerIdsBySocket.get(socket);
    if (peerId && this.clientsByPeerId.get(peerId) === socket) {
      this.clientsByPeerId.delete(peerId);
      this.broadcastPeerDisconnected(peerId);
    }
    this.peerIdsBySocket.delete(socket);
    this.rateBySocket.delete(socket);
  }

  broadcastPeerDisconnected(peerId) {
    for (const client of this.clientsByPeerId.values()) {
      send(client, {
        kind: "peer_disconnected",
        peerId,
      });
    }
  }

  closeSocket(socket, code, reason) {
    this.removeSocket(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close races.
    }
  }
}

function sanitizeRoom(value) {
  const room = String(value ?? "").trim();
  return ROOM_NAME_PATTERN.test(room) ? room : null;
}

function createShortInviteRedirect(url) {
  const match = url.pathname.match(/^\/(j|join|h|host)\/([^/]+)\/?$/);
  if (!match) return null;

  const roomId = sanitizeRoom(decodeURIComponent(match[2]));
  if (!roomId) {
    return json(
      {
        ok: false,
        error: "invalid_room",
        hint: "Use /j/ROOM or /h/ROOM with letters, numbers, dash or underscore.",
      },
      400,
    );
  }

  const role = match[1] === "h" || match[1] === "host" ? "host" : "guest";
  const hostColor = normalizeHostColor(url.searchParams.get("hostColor") ?? url.searchParams.get("color"));
  const target = buildChessUrl(role, roomId, hostColor);
  return Response.redirect(target.toString(), 302);
}

function buildChessUrl(role, roomId, hostColor) {
  const target = new URL("single-file-chess-game/index.html", DASHBOARD_URL);
  const hostPeer = `chess-host-${roomId}`;
  target.searchParams.set("transport", "websocket");
  target.searchParams.set("role", role);
  target.searchParams.set("room", roomId);
  target.searchParams.set("peer", role === "host" ? hostPeer : `chess-guest-${roomId}`);
  target.searchParams.set("signaling", relayUrlForRoom(roomId));
  target.searchParams.set("hostColor", hostColor);
  if (role === "guest") target.searchParams.set("host", hostPeer);
  return target;
}

function relayUrlForRoom(roomId) {
  const relayUrl = new URL(PUBLIC_RELAY_URL);
  relayUrl.searchParams.set("room", roomId);
  return relayUrl.toString();
}

function normalizeHostColor(value) {
  return String(value ?? "").toLowerCase() === "black" || String(value ?? "").toLowerCase() === "b"
    ? "black"
    : "white";
}

function parseClientMessage(serialized) {
  try {
    const parsed = JSON.parse(serialized);
    if (parsed?.kind === "register" && isPeerId(parsed.peerId)) {
      return {
        kind: "register",
        peerId: parsed.peerId,
      };
    }
    if (parsed?.kind === "transport" && isChannel(parsed.channel)) {
      return {
        kind: "transport",
        toPeerId: isPeerId(parsed.toPeerId) ? parsed.toPeerId : undefined,
        channel: parsed.channel,
        data: parsed.data,
      };
    }
    if (parsed?.kind === "signal" && isPeerId(parsed.toPeerId) && Object.hasOwn(parsed, "payload")) {
      return {
        kind: "signal",
        toPeerId: parsed.toPeerId,
        payload: parsed.payload,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isPeerId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isChannel(value) {
  return CHANNELS.has(value);
}

function send(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A broken socket will be cleaned up by its close/error event.
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
