import peerjsRuntime from "peerjs";
import type { DataConnection, Peer as PeerType, PeerJSOption } from "peerjs";
import { EventSlot } from "./events.js";
import type { PeerId, Unsubscribe } from "./protocol.js";
import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "./transport.js";
import { isTransportChannelName } from "./transport.js";

const TRANSPORT_MARKER = "__gameNetworkTransport";

export interface PeerJsTransportOptions {
  peerId: PeerId;
  peerOptions: PeerJSOption;
}

interface PeerJsTransportPayload {
  [TRANSPORT_MARKER]: 1;
  channel: TransportChannelName;
  data: unknown;
}

export class PeerJsTransport implements GameNetworkTransport {
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();
  private readonly errorSlot = new EventSlot<[Error]>();
  private readonly connections = new Map<PeerId, DataConnection>();
  private readonly queues = new Map<PeerId, PeerJsTransportPayload[]>();

  private constructor(private readonly peer: PeerType) {
    this.localPeerId = peer.id;
    peer.on("connection", (connection) => this.registerConnection(connection));
    peer.on("close", () => this.closeSlot.emit());
    peer.on("disconnected", () => this.closeSlot.emit());
    peer.on("error", (error) => this.errorSlot.emit(error));
  }

  readonly localPeerId: PeerId;

  static async create(options: PeerJsTransportOptions): Promise<PeerJsTransport> {
    const peer = new (resolvePeerConstructor())(options.peerId, options.peerOptions);
    await waitForPeerOpen(peer);
    return new PeerJsTransport(peer);
  }

  async connect(peerId: PeerId): Promise<void> {
    const existingConnection = this.connections.get(peerId);
    if (existingConnection?.open) return;

    const connection = this.peer.connect(peerId, {
      label: "game-network",
      serialization: "json",
      reliable: true,
    });
    this.registerConnection(connection);
    await waitForConnectionOpen(connection);
  }

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    const payload = createTransportPayload(channel, data);
    const connection = this.connections.get(toPeerId);

    if (connection?.open) {
      connection.send(payload);
      return;
    }

    const queue = this.queues.get(toPeerId) ?? [];
    queue.push(payload);
    this.queues.set(toPeerId, queue);
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    for (const peerId of this.connections.keys()) {
      this.send(peerId, channel, data);
    }
  }

  close(): void {
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
    this.queues.clear();
    if (!this.peer.destroyed) {
      this.peer.destroy();
    }
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

  private registerConnection(connection: DataConnection): void {
    this.connections.set(connection.peer, connection);

    connection.on("open", () => {
      this.flushQueue(connection.peer);
    });
    connection.on("data", (data) => {
      if (!isTransportPayload(data)) return;
      this.messageSlot.emit({
        channel: data.channel,
        fromPeerId: connection.peer,
        toPeerId: this.localPeerId,
        data: data.data,
      });
    });
    connection.on("close", () => {
      if (this.connections.get(connection.peer) === connection) {
        this.connections.delete(connection.peer);
      }
    });
    connection.on("error", (error) => this.errorSlot.emit(error));

    if (connection.open) {
      this.flushQueue(connection.peer);
    }
  }

  private flushQueue(peerId: PeerId): void {
    const connection = this.connections.get(peerId);
    if (!connection?.open) return;

    const queue = this.queues.get(peerId) ?? [];
    this.queues.delete(peerId);
    for (const payload of queue) {
      connection.send(payload);
    }
  }
}

function createTransportPayload(
  channel: TransportChannelName,
  data: unknown,
): PeerJsTransportPayload {
  return {
    [TRANSPORT_MARKER]: 1,
    channel,
    data,
  };
}

function isTransportPayload(value: unknown): value is PeerJsTransportPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate[TRANSPORT_MARKER] === 1 &&
    isTransportChannelName(candidate.channel) &&
    "data" in candidate
  );
}

function waitForPeerOpen(peer: PeerType): Promise<void> {
  if (peer.open) return Promise.resolve();

  return new Promise((resolve, reject) => {
    peer.once("open", () => resolve());
    peer.once("error", (error) => reject(error));
  });
}

function resolvePeerConstructor(): new (id: string, options?: PeerJSOption) => PeerType {
  if (typeof peerjsRuntime === "function") {
    return peerjsRuntime as unknown as new (id: string, options?: PeerJSOption) => PeerType;
  }

  const runtime = peerjsRuntime as unknown as {
    Peer?: new (id: string, options?: PeerJSOption) => PeerType;
    default?: new (id: string, options?: PeerJSOption) => PeerType;
  };
  const constructor = runtime.Peer ?? runtime.default;
  if (!constructor) {
    throw new Error("PeerJS constructor is unavailable");
  }
  return constructor;
}

function waitForConnectionOpen(connection: DataConnection): Promise<void> {
  if (connection.open) return Promise.resolve();

  return new Promise((resolve, reject) => {
    connection.once("open", () => resolve());
    connection.once("error", (error) => reject(error));
  });
}
