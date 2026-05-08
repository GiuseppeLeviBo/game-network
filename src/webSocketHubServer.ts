import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { isTransportChannelName, type TransportChannelName } from "./transport.js";

export interface StartWebSocketHubServerOptions {
  port: number;
  host?: string;
  path?: string;
}

export interface AttachWebSocketHubServerOptions {
  server: HttpServer;
  path?: string;
}

type HubClientMessage =
  | {
      kind: "register";
      peerId: string;
    }
  | {
      kind: "transport";
      toPeerId?: string;
      channel: TransportChannelName;
      data: unknown;
    }
  | {
      kind: "signal";
      toPeerId: string;
      payload: unknown;
    };

type HubServerMessage =
  | {
      kind: "registered";
      peerId: string;
    }
  | {
      kind: "transport";
      fromPeerId: string;
      toPeerId?: string;
      channel: TransportChannelName;
      data: unknown;
    }
  | {
      kind: "signal";
      fromPeerId: string;
      toPeerId: string;
      payload: unknown;
    };

export function startWebSocketHubServer(options: StartWebSocketHubServerOptions): WebSocketServer {
  const server = new WebSocketServer({
    host: options.host ?? "127.0.0.1",
    port: options.port,
    path: options.path,
  });
  configureWebSocketHubServer(server);
  return server;
}

export function attachWebSocketHubServer(options: AttachWebSocketHubServerOptions): WebSocketServer {
  const server = new WebSocketServer({
    server: options.server,
    path: options.path,
  });
  configureWebSocketHubServer(server);
  return server;
}

function configureWebSocketHubServer(server: WebSocketServer): void {
  const clientsByPeerId = new Map<string, WebSocket>();
  const peerIdsByClient = new WeakMap<WebSocket, string>();
  server.on("connection", (client) => {
    client.on("message", (rawData) => {
      const message = parseMessage(rawData.toString());
      if (!message) return;

      if (message.kind === "register") {
        clientsByPeerId.set(message.peerId, client);
        peerIdsByClient.set(client, message.peerId);
        send(client, {
          kind: "registered",
          peerId: message.peerId,
        });
        return;
      }

      const fromPeerId = peerIdsByClient.get(client);
      if (!fromPeerId) return;

      if (message.kind === "transport") {
        const outgoing: HubServerMessage = {
          kind: "transport",
          fromPeerId,
          toPeerId: message.toPeerId,
          channel: message.channel,
          data: message.data,
        };
        forwardOrBroadcast(clientsByPeerId, fromPeerId, message.toPeerId, outgoing);
        return;
      }

      if (message.kind === "signal") {
        const target = clientsByPeerId.get(message.toPeerId);
        if (!target) return;
        send(target, {
          kind: "signal",
          fromPeerId,
          toPeerId: message.toPeerId,
          payload: message.payload,
        });
      }
    });

    client.on("close", () => {
      const peerId = peerIdsByClient.get(client);
      if (peerId && clientsByPeerId.get(peerId) === client) {
        clientsByPeerId.delete(peerId);
      }
    });
  });
}

function forwardOrBroadcast(
  clientsByPeerId: Map<string, WebSocket>,
  fromPeerId: string,
  toPeerId: string | undefined,
  message: HubServerMessage,
): void {
  if (toPeerId) {
    const target = clientsByPeerId.get(toPeerId);
    if (target) send(target, message);
    return;
  }

  for (const [peerId, client] of clientsByPeerId) {
    if (peerId !== fromPeerId) {
      send(client, message);
    }
  }
}

function parseMessage(serialized: string): HubClientMessage | undefined {
  try {
    const parsed = JSON.parse(serialized) as Partial<HubClientMessage>;
    if (parsed.kind === "register" && typeof parsed.peerId === "string") {
      return parsed as HubClientMessage;
    }
    if (
      parsed.kind === "transport" &&
      isTransportChannelName(parsed.channel)
    ) {
      return parsed as HubClientMessage;
    }
    if (
      parsed.kind === "signal" &&
      typeof parsed.toPeerId === "string" &&
      "payload" in parsed
    ) {
      return parsed as HubClientMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function send(client: WebSocket, message: HubServerMessage): void {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
}
