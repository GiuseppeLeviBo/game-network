import { EventSlot } from "./events.js";
import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "./transport.js";
import type { PeerId, Unsubscribe } from "./protocol.js";

export class FakeNetwork {
  private readonly transports = new Map<PeerId, FakeTransport>();

  createPeer(peerId: PeerId): FakeTransport {
    if (this.transports.has(peerId)) {
      throw new Error(`Fake peer already exists: ${peerId}`);
    }

    const transport = new FakeTransport(peerId, this);
    this.transports.set(peerId, transport);
    return transport;
  }

  deliver(message: TransportMessage): void {
    if (message.toPeerId) {
      this.transports.get(message.toPeerId)?.receive(message);
      return;
    }

    for (const [peerId, transport] of this.transports) {
      if (peerId !== message.fromPeerId) {
        transport.receive(message);
      }
    }
  }

  remove(peerId: PeerId): void {
    this.transports.delete(peerId);
    for (const transport of this.transports.values()) {
      transport.receivePeerDisconnected(peerId);
    }
  }
}

export class FakeTransport implements GameNetworkTransport {
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();
  private readonly peerDisconnectedSlot = new EventSlot<[PeerId]>();
  private isClosed = false;

  constructor(
    readonly localPeerId: PeerId,
    private readonly network: FakeNetwork,
  ) {}

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    this.assertOpen();
    this.network.deliver({
      channel,
      fromPeerId: this.localPeerId,
      toPeerId,
      data,
    });
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    this.assertOpen();
    this.network.deliver({
      channel,
      fromPeerId: this.localPeerId,
      data,
    });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.network.remove(this.localPeerId);
    this.closeSlot.emit();
  }

  receive(message: TransportMessage): void {
    if (!this.isClosed) {
      this.messageSlot.emit(message);
    }
  }

  receivePeerDisconnected(peerId: PeerId): void {
    if (!this.isClosed) {
      this.peerDisconnectedSlot.emit(peerId);
    }
  }

  onMessage(handler: (message: TransportMessage) => void): Unsubscribe {
    return this.messageSlot.subscribe(handler);
  }

  onClose(handler: () => void): Unsubscribe {
    return this.closeSlot.subscribe(handler);
  }

  onPeerDisconnected(handler: (peerId: PeerId) => void): Unsubscribe {
    return this.peerDisconnectedSlot.subscribe(handler);
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error(`Fake peer is closed: ${this.localPeerId}`);
    }
  }
}
