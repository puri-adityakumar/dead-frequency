/** Stable boundary between the independently implemented engine, UI, and director. */
export type RoomId = 'arrival' | 'medical' | 'archives' | 'reactor' | 'exit';
export type Milestone = 'start' | 'room_enter' | 'relay_restored' | 'near_death' | 'exit_ready';
export type DirectorAction = 'whisper' | 'lights_flicker' | 'false_alarm' | 'hunt' | 'help';

export interface DirectorState {
  seed: number;
  elapsed: number;
  room: RoomId;
  visitedRooms: RoomId[];
  relays: number;
  health: number;
  flashlight: boolean;
  threat: number;
  milestone: Milestone;
  recentMessages: string[];
}

export interface DirectorEvent {
  action: DirectorAction;
  room: RoomId;
  message: string;
  intensity: number;
}

export interface DirectorResponse {
  source: 'live' | 'fallback';
  event: DirectorEvent;
  reason?: string;
}

export interface GameSnapshot {
  phase: 'ready' | 'playing' | 'paused' | 'dead' | 'choice' | 'won';
  seed: number;
  elapsed: number;
  health: number;
  relays: number;
  room: RoomId;
  flashlight: boolean;
  stamina: number;
  threat: number;
  interaction: string | null;
  ending: 'release' | 'shutdown' | null;
}

export type SoundCue = 'step' | 'relay' | 'hurt' | 'static' | 'alarm' | 'ending';

export interface GameOptions {
  seed?: number;
  onSnapshot: (snapshot: GameSnapshot) => void;
  onMilestone: (state: DirectorState) => void;
  onSound: (cue: SoundCue) => void;
}

export interface GameController {
  start(): void;
  pause(): void;
  resume(): void;
  reset(seed?: number): void;
  destroy(): void;
  interact(): void;
  toggleFlashlight(): void;
  chooseEnding(ending: 'release' | 'shutdown'): void;
  applyDirectorEvent(event: DirectorEvent): void;
  setTouchInput(x: number, y: number, sprint: boolean): void;
  getSnapshot(): GameSnapshot;
}
