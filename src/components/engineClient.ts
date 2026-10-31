/**
 * Soft loader for the engine package (`@/game`).
 *
 * Import lazily in the browser. Download failures and invalid module shapes
 * stay on the boot panel; the shell retries at most three times.
 */
import type { GameController, GameOptions } from '@/shared/contracts';

export interface EngineModule {
  createGame(canvas: HTMLCanvasElement, options: GameOptions): GameController;
}

export type EngineLoadResult =
  | { kind: 'ok'; module: EngineModule }
  | { kind: 'missing' }
  | { kind: 'fault'; error: unknown };

export async function loadEngineModule(): Promise<EngineLoadResult> {
  if (typeof window === 'undefined') {
    // Engine is browser-only; never import during SSR.
    return { kind: 'missing' };
  }
  try {
    const mod: unknown = await import('@/game');
    if (mod && typeof (mod as EngineModule).createGame === 'function') {
      return { kind: 'ok', module: mod as EngineModule };
    }
    // The downloaded module must satisfy the controller contract.
    return { kind: 'missing' };
  } catch (error: unknown) {
    // Distinguish a missing download from an engine execution fault.
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      /cannot find module|Failed to fetch dynamically imported module|not found|404/i.test(message);
    if (missing) {
      return { kind: 'missing' };
    }
    return { kind: 'fault', error };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
