/**
 * Director link — UI-side client for the same-origin `/api/director` endpoint.
 *
 * Contract (see docs/IMPLEMENTATION_PLAN.md):
 * - Engine calls `onMilestone(snapshot state)`; we POST a sanitized, bounded
 *   `DirectorState` asynchronously — gameplay never waits on the response.
 * - Single-flight with a "latest wins" pending slot: no overlap, no request
 *   storms; chained queued submissions drain one at a time.
 * - Every request is stamped with the current run; responses from a previous
 *   run (or after reset/unmount) are rejected, never applied.
 * - AbortController with a hard timeout; cancelled cleanly on reset/unmount.
 * - On transport failure, timeout, or invalid payload: a LOCAL fallback
 *   whisper is generated in-house and is explicitly labelled `fallback`.
 *   Live AI is never claimed — the link colour/message source drives the badge,
 *   and it only flips to LIVE after a real server response says so.
 */
import type {
  DirectorAction,
  DirectorEvent,
  DirectorResponse,
  DirectorState,
  RoomId,
  Milestone,
} from '@/shared/contracts';

export type LinkStatus = 'idle' | 'live' | 'fallback';
export type RadioKind = 'live' | 'fallback' | 'system';

export interface RadioMessage {
  id: number;
  kind: RadioKind;
  text: string;
  /** Small grey annotation, e.g. the failure reason for a local fallback. */
  note?: string;
}

interface Job {
  state: DirectorState;
}

interface OkOutcome {
  kind: 'ok';
  event: DirectorEvent;
  source: DirectorResponse['source'];
  reason?: string;
}

interface ErrOutcome {
  kind: 'err';
  reason: string;
}

const DIRECTOR_ROUTE = '/api/director';
const TIMEOUT_MS = 9000;
const MAX_RECENT = 8;
const MAX_CHARS = 160;

const ROOM_IDS: readonly RoomId[] = ['arrival', 'medical', 'archives', 'reactor', 'exit'];
const MILESTONES: readonly Milestone[] = [
  'start',
  'room_enter',
  'relay_restored',
  'near_death',
  'exit_ready',
];
const ACTIONS: readonly DirectorAction[] = ['whisper', 'lights_flicker', 'false_alarm', 'hunt', 'help'];

/**
 * In-house scripted fallback copy. Original text, written for this project;
 * always delivered as kind "fallback" with the FALLBACK tag — never labelled
 * live, never pretended to be model output.
 */
const LOCAL_WHISPERS: readonly string[] = [
  '…carrier hiss only. no station answers, but the room keeps breathing on the line.',
  '…a fragment of speech loops in the static — repetition without a mouth.',
  '…the frequency folds back on itself. something out here is listening anyway.',
  '…three blind relays, one open channel. the dark answers at a lower register.',
  '…the signal hums along the walls like it is looking for a room to match.',
];

export interface DirectorLinkOptions {
  /**
   * Deliver an event to the game: apply through the engine controller and add
   * it to the radio transcript with its source label.
   */
  deliver: (event: DirectorEvent, kind: 'live' | 'fallback', reason?: string) => void;
  /** Report link-level status for the HUD badge. */
  onLink: (status: LinkStatus) => void;
}

export class DirectorLink {
  private opts: DirectorLinkOptions;
  private run = -1;
  private epoch = 0;
  private seq = 0;
  private activeSeq = -1;
  private inflight = false;
  private pending: Job | null = null;
  private abortController: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private whisperIndex = 0;

  constructor(options: DirectorLinkOptions) {
    this.opts = options;
  }

  /**
   * Move to a new run (reset/retry). Aborts anything in flight; earlier
   * responses are stale by epoch and get dropped on arrival.
   */
  newRun(id: number): void {
    if (id <= this.run) return;
    this.run = id;
    this.epoch += 1;
    this.pending = null;
    this.cancelFlight();
    if (!this.destroyed) {
      this.opts.onLink('idle');
    }
  }

  /**
   * Engine milestone callback. Synchronous-friendly: never blocks, never
   * throws. Stale runs are ignored; repeats of the same milestone in one run
   * (e.g. one per restored relay) are all delivered. No overlap: an in-flight
   * request is followed by at most one queued latest submission.
   */
  submit(state: DirectorState, run: number): void {
    if (this.destroyed || run !== this.run) return;
    const sanitized = sanitizeState(state);
    if (!sanitized) return;
    if (this.inflight) {
      // Latest wins; at most one queued job exists at any time.
      this.pending = { state: sanitized };
      return;
    }
    void this.fly(sanitized);
  }

  /** Final teardown (unmount). Aborts in flight and rejects future work. */
  destroy(): void {
    this.destroyed = true;
    this.pending = null;
    this.cancelFlight();
  }

  // ---------------------------------------------------------------- internals

  private cancelFlight(): void {
    // Invalidate the old flight immediately. Its finally block must not clear
    // the next run's request or consume the next run's pending milestone.
    this.activeSeq = -1;
    this.inflight = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
  }

  private stale(epoch: number, seq: number): boolean {
    return this.destroyed || epoch !== this.epoch || seq !== this.activeSeq;
  }

  private async fly(state: DirectorState): Promise<void> {
    this.inflight = true;
    const epoch = this.epoch;
    const seq = ++this.seq;
    this.activeSeq = seq;
    try {
      const outcome = await this.request(state);
      if (this.stale(epoch, seq)) return;
      if (outcome.kind === 'ok') {
        if (outcome.source === 'live') {
          this.opts.onLink('live');
          this.opts.deliver(outcome.event, 'live', outcome.reason);
        } else {
          // Server-validated fallback: explicitly labelled, never live.
          this.opts.onLink('fallback');
          this.opts.deliver(outcome.event, 'fallback', outcome.reason ?? 'director fallback');
        }
      } else {
        this.locals(state, outcome.reason);
      }
    } catch (error: unknown) {
      if (this.stale(epoch, seq)) return;
      this.locals(state, describeFailure(error));
    } finally {
      if (this.activeSeq === seq) {
        this.inflight = false;
        if (!this.destroyed && !this.stale(epoch, seq) && this.pending) {
          const next = this.pending;
          this.pending = null;
          void this.fly(next.state);
        }
      }
    }
  }

  private async request(state: DirectorState): Promise<OkOutcome | ErrOutcome> {
    const controller = new AbortController();
    this.abortController = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    this.timer = timer;
    try {
      const response = await fetch(DIRECTOR_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { kind: 'err', reason: `director endpoint ${response.status}` };
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { kind: 'err', reason: 'invalid director payload' };
      }
      const parsed = parseResponse(data);
      if (!parsed) {
        return { kind: 'err', reason: 'invalid director payload' };
      }
      return { kind: 'ok', event: parsed.event, source: parsed.source, reason: parsed.reason };
    } finally {
      // Keep the timeout active through response-body consumption, not just
      // until headers arrive. Reset may already have started another flight.
      clearTimeout(timer);
      if (this.abortController === controller) {
        this.timer = null;
        this.abortController = null;
      }
    }
  }

  /** Local, explicitly-fallback content for transport/validation failures. */
  private locals(state: DirectorState, reason: string): void {
    const message = LOCAL_WHISPERS[this.whisperIndex % LOCAL_WHISPERS.length]!;
    this.whisperIndex += 1;
    const event: DirectorEvent = {
      action: 'whisper',
      room: state.room,
      message,
      intensity: Math.min(0.5, 0.15 + state.threat * 0.35),
    };
    this.opts.onLink('fallback');
    this.opts.deliver(event, 'fallback', reason);
  }
}

/** Human-readable reason for the radio note; never implies a live AI status. */
export function describeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'director timeout';
  }
  if (error instanceof TypeError) {
    return 'director route unreachable';
  }
  return 'director error';
}

// ------------------------------------------------------------------ sanitizing

/**
 * Bounded payload built from the engine milestone snapshot. Whitelisted fields
 * only, numbers clamped, recentMessages trimmed to the last N max-length
 * strings — the server runs strict schemas and must never see free-form bulk.
 */
export function sanitizeState(raw: DirectorState): DirectorState | null {
  if (!raw || typeof raw !== 'object') return null;
  const milestone = MILESTONES.includes(raw.milestone) ? raw.milestone : null;
  const room = ROOM_IDS.includes(raw.room) ? raw.room : null;
  if (!milestone || !room) return null;

  const visited = Array.from(new Set(raw.visitedRooms.filter((r) => ROOM_IDS.includes(r)))).slice(
    -MAX_RECENT,
  );
  const recent = boundRecentMessages(raw.recentMessages);

  return {
    seed: clampNumber(raw.seed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Math.trunc),
    elapsed: clampNumber(raw.elapsed, 0, 86_400_000),
    room,
    visitedRooms: visited,
    relays: clampNumber(raw.relays, 0, 3, Math.floor),
    health: clampNumber(raw.health, 0, 100),
    flashlight: raw.flashlight === true,
    threat: clamp01(Number.isFinite(raw.threat) ? raw.threat : 0),
    milestone,
    recentMessages: recent,
  };
}

/** Merge the engine's recent messages with the UI transcript, newest last. */
export function mergeRecent(
  engineMessages: readonly string[],
  uiTexts: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  const push = (list: readonly string[]) => {
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      merged.push(text);
    }
  };
  push(engineMessages);
  push(uiTexts);
  return merged.slice(-MAX_RECENT);
}

export function boundRecentMessages(values: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, ' ').trim().slice(0, MAX_CHARS);
    if (text.trim()) texts.push(text);
  }
  return texts.slice(-MAX_RECENT);
}

function clampNumber(
  value: number,
  min: number,
  max: number,
  round: (n: number) => number = Math.floor,
): number {
  return round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

// ------------------------------------------------------------------ validation

function parseResponse(data: unknown): { source: DirectorResponse['source']; event: DirectorEvent; reason?: string } | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const source = record.source;
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, 120) : undefined;
  if (source !== 'live' && source !== 'fallback') return null;
  const event = parseEvent(record.event);
  if (!event) return null;
  return { source, event, reason };
}

function parseEvent(value: unknown): DirectorEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!ACTIONS.includes(record.action as DirectorAction)) return null;
  if (!ROOM_IDS.includes(record.room as RoomId)) return null;
  if (typeof record.message !== 'string') return null;
  const message = record.message.trim();
  if (!message || message.length > 140 || /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/.test(message)) return null;
  if (typeof record.intensity !== 'number' || !Number.isFinite(record.intensity)
    || record.intensity < 0 || record.intensity > 1) return null;
  return {
    action: record.action as DirectorAction,
    room: record.room as RoomId,
    message,
    intensity: record.intensity,
  };
}
