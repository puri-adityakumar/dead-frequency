/**
 * Dead Frequency — engine entry point.
 *
 * Contract surface (from ../shared/contracts):
 *   createGame(canvas: HTMLCanvasElement, options: GameOptions): GameController
 *
 * Normalisation notes for the UI layer (see DESIGN.md for details):
 *   - health, stamina and threat are 0..1 fractions;
 *   - elapsed is in seconds (sim time, frozen while paused);
 *   - relays is 0..3;
 *   - interaction is a short prompt string or null.
 */

import { createGame as buildGame, type DeadFrequencyGame } from './controller';
import type { World } from './sim';
import { TUNE } from './sim';

export type { DeadFrequencyGame };

export const createGame = buildGame;

export { TUNE };
export type { World };

export const ENGINE_META = {
  name: 'Dead Frequency',
  version: '1.0.0',
  stepHz: 60,
  dprCap: 2,
} as const;
