import { EventSlot } from "./events.js";
import type { PeerId, Unsubscribe } from "./protocol.js";
import type {
  GameNetworkTransport,
  TransportChannelName,
  TransportMessage,
} from "./transport.js";

export interface NativeWebRtcTransportOptions {
  peerId: PeerId;
  signalingUrl: string;
  rtcConfig?: RTCConfiguration;
}

type SignalPayload =
  | {
      type: "offer";
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "candidate";
      candidate: RTCIceCandidateInit;
    };

type HubClientMessage =
  | {
      kind: "register";
      peerId: PeerId;
    }
  | {
      kind: "signal";
      toPeerId: PeerId;
      payload: SignalPayload;
    };

type HubServerMessage =
  | {
      kind: "registered";
      peerId: PeerId;
    }
  | {
      kind: "signal";
      fromPeerId: PeerId;
      toPeerId: PeerId;
      payload: SignalPayload;
    };

interface DataChannelPayload {
  marker: "game-network-native-webrtc";
  channel: TransportChannelName;
  data: unknown;
}

interface PeerState {
  connection: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  queue: DataChannelPayload[];
  pendingCandidates: RTCIceCandidateInit[];
}

export class NativeWebRtcTransport implements GameNetworkTransport {
  private readonly messageSlot = new EventSlot<[TransportMessage]>();
  private readonly closeSlot = new EventSlot<[]>();
  private readonly errorSlot = new EventSlot<[Error]>();
  private readonly peers = new Map<PeerId, PeerState>();
  private readonly signalingSocket: WebSocket;

  private constructor(
    readonly localPeerId: PeerId,
    signalingSocket: WebSocket,
    private readonly rtcConfig: RTCConfiguration,
  ) {
    this.signalingSocket = signalingSocket;
    signalingSocket.addEventListener("message", (event) => {
      void this.handleSignalingMessage(event.data);
    });
    signalingSocket.addEventListener("close", () => this.closeSlot.emit());
    signalingSocket.addEventListener("error", () =>
      this.errorSlot.emit(new Error("WebRTC signaling socket error")),
    );
  }

  static async create(options: NativeWebRtcTransportOptions): Promise<NativeWebRtcTransport> {
    const socket = new WebSocket(options.signalingUrl);
    await waitForSocketOpen(socket);
    const transport = new NativeWebRtcTransport(
      options.peerId,
      socket,
      options.rtcConfig ?? { iceServers: [] },
    );
    transport.sendSignalRaw({
      kind: "register",
      peerId: options.peerId,
    });
    return transport;
  }

  async connect(peerId: PeerId): Promise<void> {
    const state = this.getOrCreatePeerState(peerId);
    if (state.dataChannel?.readyState === "open") return;

    const dataChannel = state.connection.createDataChannel("game-network", {
      ordered: true,
    });
    this.registerDataChannel(peerId, state, dataChannel);

    const offer = await state.connection.createOffer();
    await state.connection.setLocalDescription(offer);
    this.sendSignal(peerId, {
      type: "offer",
      description: offer,
    });

    await waitForDataChannelOpen(dataChannel);
  }

  send(toPeerId: PeerId, channel: TransportChannelName, data: unknown): void {
    const state = this.getOrCreatePeerState(toPeerId);
    const payload = createPayload(channel, data);
    if (state.dataChannel?.readyState === "open") {
      state.dataChannel.send(JSON.stringify(payload));
      return;
    }

    state.queue.push(payload);
  }

  broadcast(channel: TransportChannelName, data: unknown): void {
    for (const peerId of this.peers.keys()) {
      this.send(peerId, channel, data);
    }
  }

  close(): void {
    for (const state of this.peers.values()) {
      state.dataChannel?.close();
      state.connection.close();
    }
    this.peers.clear();
    this.signalingSocket.close();
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

  private async handleSignalingMessage(data: unknown): Promise<void> {
    const message = parseHubMessage(data);
    if (!message || message.kind !== "signal") return;

    const peerId = message.fromPeerId;
    const state = this.getOrCreatePeerState(peerId);
    const payload = message.payload;

    if (payload.type === "offer") {
      await state.connection.setRemoteDescription(payload.description);
      await this.flushPendingCandidates(state);
      const answer = await state.connection.createAnswer();
      await state.connection.setLocalDescription(answer);
      this.sendSignal(peerId, {
        type: "answer",
        description: answer,
      });
      return;
    }

    if (payload.type === "answer") {
      await state.connection.setRemoteDescription(payload.description);
      await this.flushPendingCandidates(state);
      return;
    }

    if (payload.type === "candidate") {
      if (state.connection.remoteDescription) {
        await state.connection.addIceCandidate(payload.candidate);
      } else {
        state.pendingCandidates.push(payload.candidate);
      }
    }
  }

  private getOrCreatePeerState(peerId: PeerId): PeerState {
    const existingState = this.peers.get(peerId);
    if (existingState) return existingState;

    const connection = new RTCPeerConnection(this.rtcConfig);
    const state: PeerState = {
      connection,
      queue: [],
      pendingCandidates: [],
    };

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.sendSignal(peerId, {
        type: "candidate",
        candidate: event.candidate.toJSON(),
      });
    });
    connection.addEventListener("datachannel", (event) => {
      this.registerDataChannel(peerId, state, event.channel);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "closed" ||
        connection.connectionState === "disconnected"
      ) {
        this.peers.delete(peerId);
      }
    });

    this.peers.set(peerId, state);
    return state;
  }

  private registerDataChannel(
    peerId: PeerId,
    state: PeerState,
    dataChannel: RTCDataChannel,
  ): void {
    state.dataChannel = dataChannel;
    dataChannel.addEventListener("open", () => this.flushDataQueue(state));
    dataChannel.addEventListener("message", (event) => {
      const payload = parseDataChannelPayload(event.data);
      if (!payload) return;
      this.messageSlot.emit({
        channel: payload.channel,
        fromPeerId: peerId,
        toPeerId: this.localPeerId,
        data: payload.data,
      });
    });
    dataChannel.addEventListener("error", () =>
      this.errorSlot.emit(new Error(`DataChannel error from ${peerId}`)),
    );

    if (dataChannel.readyState === "open") {
      this.flushDataQueue(state);
    }
  }

  private flushDataQueue(state: PeerState): void {
    const dataChannel = state.dataChannel;
    if (!dataChannel || dataChannel.readyState !== "open") return;
    const queue = [...state.queue];
    state.queue.length = 0;
    for (const payload of queue) {
      dataChannel.send(JSON.stringify(payload));
    }
  }

  private async flushPendingCandidates(state: PeerState): Promise<void> {
    const candidates = [...state.pendingCandidates];
    state.pendingCandidates.length = 0;
    for (const candidate of candidates) {
      await state.connection.addIceCandidate(candidate);
    }
  }

  private sendSignal(toPeerId: PeerId, payload: SignalPayload): void {
    this.sendSignalRaw({
      kind: "signal",
      toPeerId,
      payload,
    });
  }

  private sendSignalRaw(message: HubClientMessage): void {
    this.signalingSocket.send(JSON.stringify(message));
  }
}

function createPayload(channel: TransportChannelName, data: unknown): DataChannelPayload {
  return {
    marker: "game-network-native-webrtc",
    channel,
    data,
  };
}

function parseHubMessage(data: unknown): HubServerMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as Partial<HubServerMessage>;
    if (parsed.kind === "registered" && typeof parsed.peerId === "string") {
      return parsed as HubServerMessage;
    }
    if (
      parsed.kind === "signal" &&
      typeof parsed.fromPeerId === "string" &&
      typeof parsed.toPeerId === "string" &&
      parsed.payload &&
      typeof parsed.payload === "object"
    ) {
      return parsed as HubServerMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseDataChannelPayload(data: unknown): DataChannelPayload | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as Partial<DataChannelPayload>;
    if (
      parsed.marker === "game-network-native-webrtc" &&
      (parsed.channel === "control" || parsed.channel === "realtime")
    ) {
      return parsed as DataChannelPayload;
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
    socket.addEventListener("error", () => reject(new Error("WebRTC signaling open failed")), {
      once: true,
    });
  });
}

function waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
  if (dataChannel.readyState === "open") return Promise.resolve();

  return new Promise((resolve, reject) => {
    dataChannel.addEventListener("open", () => resolve(), { once: true });
    dataChannel.addEventListener("error", () => reject(new Error("DataChannel open failed")), {
      once: true,
    });
  });
}

