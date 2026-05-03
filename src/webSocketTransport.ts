import { EventSlot } from "./events.js";
import type { PeerId, Unsubscribe } from "./protocol.js";
import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "./transport.js";

export interface WebSocketTransportOptions {
  peerId: PeerId;
  url: string;
}

type WebSocketTransportClientMessage =
  | {
      kind: "register";
      peerId: PeerId;
    }
  | {
      kind: "transport";
      toPeerId?: PeerId;
      channel: TransportChannelName;
      data: unknown;
    };

type WebSocketTransportServerMessage =
  | {
      kind: "registered";
      peerId: PeerId;
    }
  | {
      kind: "transport";
      fromPeerId: PeerId;
      toPeerId?: PeerId;
      channel: TransportChannelName;
      data: unknown;
    };

export class WebSocketTransport implements GameNetworkTransport {
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();
  private readonly errorSlot = new EventSlot<[Error]>();
  private readonly socket: WebSocket;

  private constructor(
    readonly localPeerId: PeerId,
    socket: WebSocket,
  ) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.closeSlot.emit());
    socket.addEventListener("error", () => this.errorSlot.emit(new Error("WebSocket error")));
  }

  static async create(options: WebSocketTransportOptions): Promise<WebSocketTransport> {
    const socket = new WebSocket(options.url);
    await waitForSocketOpen(socket);
    const transport = new WebSocketTransport(options.peerId, socket);
    transport.sendRaw({
      kind: "register",
      peerId: options.peerId,
    });
    return transport;
  }

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    this.sendRaw({
      kind: "transport",
      toPeerId,
      channel,
      data,
    });
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    this.sendRaw({
      kind: "transport",
      channel,
      data,
    });
  }

  close(): void {
    this.socket.close();
    this.closeSlot.emit();
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    return this.messageSlot.subscribe(handler);
  }

  onClose(handler: () => void): Unsubscribe {
    return this.closeSlot.subscribe(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errorSlot.subscribe(handler);
  }

  private handleMessage(data: unknown): void {
    const message = parseMessage(data);
    if (!message || message.kind !== "transport") return;
    this.messageSlot.emit({
      channel: message.channel,
      fromPeerId: message.fromPeerId,
      toPeerId: message.toPeerId,
      data: message.data,
    });
  }

  private sendRaw(message: WebSocketTransportClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }
}

function parseMessage(data: unknown): WebSocketTransportServerMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as Partial<WebSocketTransportServerMessage>;
    if (parsed.kind === "registered" && typeof parsed.peerId === "string") {
      return parsed as WebSocketTransportServerMessage;
    }
    if (
      parsed.kind === "transport" &&
      typeof parsed.fromPeerId === "string" &&
      (parsed.channel === "control" || parsed.channel === "realtime")
    ) {
      return parsed as WebSocketTransportServerMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), {
      once: true,
    });
  });
}

