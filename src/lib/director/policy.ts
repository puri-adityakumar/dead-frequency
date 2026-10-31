import type {
  DirectorAction,
  DirectorEvent,
  DirectorState,
  Milestone,
} from '../../shared/contracts';
import type { ModelDecision } from './schema';

const ACTION_INTENSITY: Record<DirectorAction, number> = {
  whisper: 0.2,
  lights_flicker: 0.3,
  false_alarm: 0.35,
  hunt: 0.5,
  help: 0.15,
};

const MILESTONE_CAP: Record<Milestone, number> = {
  start: 0.35,
  room_enter: 0.45,
  relay_restored: 0.55,
  near_death: 0.3,
  exit_ready: 0.5,
};

const HUNT_DOWNGRADE_MESSAGE = 'Signal interference. It loses your trail.';

function roundIntensity(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/**
 * Turns a validated model choice into a contract-safe event.
 *
 * The model cannot choose a room, an arbitrary intensity, or an effect outside
 * the finite action enum. The room always comes from the real game state, so an
 * event can never teleport the player. Hunt is downgraded while the player is
 * already close to death, so inference cannot contribute a kill.
 */
export function toDirectorEvent(
  state: DirectorState,
  decision: ModelDecision,
): DirectorEvent {
  let action = decision.action;
  let message = decision.message;

  const lowHealth = state.health <= 30;
  if (action === 'hunt' && (lowHealth || state.milestone === 'near_death')) {
    action = 'whisper';
    message = HUNT_DOWNGRADE_MESSAGE;
  }

  const intensity = roundIntensity(
    Math.min(ACTION_INTENSITY[action], MILESTONE_CAP[state.milestone]),
  );

  return {
    action,
    room: state.room,
    message,
    intensity,
  };
}
