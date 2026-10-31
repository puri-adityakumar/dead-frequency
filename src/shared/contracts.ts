/** Stable boundary between the independently implemented engine, UI, and director. */
export type RoomId = 'arrival' | 'medical' | 'archives' | 'reactor' | 'exit';
export type Milestone = 'start' | 'room_enter' | 'relay_restored' | 'near_death' | 'exit_ready';
export type DirectorAction = 'whisper' | 'lights_flicker' | 'false_alarm' | 'hunt' | 'help';

export interface DirectorState {
  seed: number;
  /** Seconds of simulation time, frozen outside the playing phase. */
  elapsed: number;
  room: RoomId;
  visitedRooms: RoomId[];
  relays: number;
  /** Percentage, 0..100. The engine converts its internal health fraction. */
  health: number;
  flashlight: boolean;
  /** Fraction, 0..1. */
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
  /** Seconds of simulation time. */
  elapsed: number;
  /** Fraction, 0..1, unlike DirectorState.health. */
  health: number;
  relays: number;
  room: RoomId;
  flashlight: boolean;
  /** Fraction, 0..1. */
  stamina: number;
  /** Fraction, 0..1. */
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
