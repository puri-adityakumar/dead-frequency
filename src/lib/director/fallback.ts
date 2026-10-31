import type {
  DirectorAction,
  DirectorEvent,
  DirectorResponse,
  DirectorState,
  Milestone,
} from '../../shared/contracts';
import type { ConfigFailureReason } from './config';

export type FallbackReason =
  | ConfigFailureReason
  | 'busy'
  | 'invalid_state'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'upstream_too_large'
  | 'invalid_upstream_response'
  | 'invalid_model_output'
  | 'internal_fallback';

type SafeFallbackAction = Exclude<DirectorAction, 'hunt'>;

interface SafeFallback {
  action: SafeFallbackAction;
  message: string;
  intensity: number;
}

/**
 * Deterministic, low-intensity, non-hostile fallback for every milestone.
 * These events never use "hunt" and stay well below 1.0, so a missing API key,
 * a busy gate, or an upstream failure cannot block, damage, or kill the player.
 */
const SAFE_FALLBACKS: Record<Milestone, SafeFallback> = {
  start: {
    action: 'whisper',
    message: 'Signal found. Keep low; the dark is listening.',
    intensity: 0.16,
  },
  room_enter: {
    action: 'lights_flicker',
    message: 'Stay off the light. Something is counting doors.',
    intensity: 0.24,
  },
  relay_restored: {
    action: 'false_alarm',
    message: 'The relay is awake. So is the thing that heard it.',
    intensity: 0.28,
  },
  near_death: {
    action: 'help',
    message: 'Breathe. The dark will hide you if you let it.',
    intensity: 0.12,
  },
  exit_ready: {
    action: 'help',
    message: 'The operator link is open. Decide before the room does.',
    intensity: 0.18,
  },
};

/** Used only when a caller bypasses request validation with an invalid state. */
export const SAFE_FALLBACK_STATE: DirectorState = {
  seed: 0,
  elapsed: 0,
  room: 'arrival',
  visitedRooms: ['arrival'],
  relays: 0,
  health: 100,
  flashlight: false,
  threat: 0,
  milestone: 'start',
  recentMessages: [],
};

export function fallbackEvent(state: DirectorState): DirectorEvent {
  const safe = SAFE_FALLBACKS[state.milestone] ?? SAFE_FALLBACKS.start;
  return {
    action: safe.action,
    room: state.room,
    message: safe.message,
    intensity: safe.intensity,
  };
}

export function fallbackResponse(
  state: DirectorState,
  reason: FallbackReason,
): DirectorResponse {
  return {
    source: 'fallback',
    event: fallbackEvent(state),
    reason,
  };
}
