export const PROTOCOL_VERSION = 1;

export type PlayerId = string;
export type PeerId = string;
export type RoomId = string;
export type Unsubscribe = () => void;

export type RoomStatus =
  | "lobby"
  | "starting"
  | "running"
  | "paused"
  | "ended"
  | "closed";

export interface PlayerInfo {
  id: PlayerId;
  peerId: PeerId;
  displayName: string;
  isHost: boolean;
}

export interface RoomInfo<GameConfig = unknown> {
  id: RoomId;
  hostPeerId: PeerId;
  maxPlayers: number;
  status: RoomStatus;
  players: PlayerInfo[];
  gameConfig?: GameConfig;
}

export interface MessageEnvelope<TType extends string = string, TPayload = unknown> {
  version: typeof PROTOCOL_VERSION;
  type: TType;
  roomId: RoomId;
  senderPeerId: PeerId;
  seq?: number;
  sentAt?: number;
  payload: TPayload;
}

export interface JoinRequestPayload {
  displayName: string;
  clientProtocolVersion: number;
}

export interface JoinAcceptPayload<GameConfig = unknown> {
  localPlayer: PlayerInfo;
  room: RoomInfo<GameConfig>;
}

export interface JoinRejectPayload {
  reason: "version_mismatch" | "room_full" | "invalid_room" | "closed";
  message: string;
}

export interface PlayerJoinedPayload {
  player: PlayerInfo;
  players: PlayerInfo[];
}

export interface PlayerLeftPayload {
  playerId: PlayerId;
  reason?: string;
  players: PlayerInfo[];
}

export interface InputEnvelope<GameInput> {
  playerId: PlayerId;
  clientSeq: number;
  sentAt?: number;
  receivedAt?: number;
  oneWayDelayMs?: number;
  input: GameInput;
}

export interface SnapshotEnvelope<GameSnapshot> {
  hostSeq: number;
  sentAt?: number;
  receivedAt?: number;
  oneWayDelayMs?: number;
  snapshot: GameSnapshot;
}

export interface GameEventEnvelope<GameEvent> {
  hostSeq: number;
  sentAt?: number;
  receivedAt?: number;
  oneWayDelayMs?: number;
  event: GameEvent;
}

export interface SyncRequestPayload {
  syncSeq: number;
  t1: number;
}

export interface SyncResponsePayload {
  syncSeq: number;
  t1: number;
  t2: number;
  t3: number;
}

export type LobbyMessage<GameConfig = unknown> =
  | MessageEnvelope<"join_request", JoinRequestPayload>
  | MessageEnvelope<"join_accept", JoinAcceptPayload<GameConfig>>
  | MessageEnvelope<"join_reject", JoinRejectPayload>
  | MessageEnvelope<"player_joined", PlayerJoinedPayload>
  | MessageEnvelope<"player_left", PlayerLeftPayload>
  | MessageEnvelope<"room_update", RoomInfo<GameConfig>>;

export type RuntimeMessage<GameInput = unknown, GameSnapshot = unknown, GameEvent = unknown> =
  | MessageEnvelope<"input", InputEnvelope<GameInput>>
  | MessageEnvelope<"snapshot", SnapshotEnvelope<GameSnapshot>>
  | MessageEnvelope<"game_event", GameEventEnvelope<GameEvent>>
  | MessageEnvelope<"ping", { nonce: string }>
  | MessageEnvelope<"pong", { nonce: string }>;

export type SyncMessage =
  | MessageEnvelope<"sync_req", SyncRequestPayload>
  | MessageEnvelope<"sync_resp", SyncResponsePayload>;

export type GameNetworkMessage<
  GameInput = unknown,
  GameSnapshot = unknown,
  GameEvent = unknown,
  GameConfig = unknown,
> = LobbyMessage<GameConfig> | RuntimeMessage<GameInput, GameSnapshot, GameEvent> | SyncMessage;

export function createEnvelope<TType extends string, TPayload>(options: {
  type: TType;
  roomId: RoomId;
  senderPeerId: PeerId;
  payload: TPayload;
  seq?: number;
  sentAt?: number;
}): MessageEnvelope<TType, TPayload> {
  return {
    version: PROTOCOL_VERSION,
    type: options.type,
    roomId: options.roomId,
    senderPeerId: options.senderPeerId,
    seq: options.seq,
    sentAt: options.sentAt,
    payload: options.payload,
  };
}

export function isProtocolEnvelope(value: unknown): value is MessageEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === PROTOCOL_VERSION &&
    typeof candidate.type === "string" &&
    typeof candidate.roomId === "string" &&
    typeof candidate.senderPeerId === "string" &&
    "payload" in candidate
  );
}
