import { z } from 'zod';
import type {
  DirectorAction,
  DirectorEvent,
  DirectorResponse,
  DirectorState,
  Milestone,
  RoomId,
} from '../../shared/contracts';
import {
  MAX_OPERATOR_MESSAGE_CHARS,
  MAX_RADIO_MESSAGE_CHARS,
  MAX_RECENT_MESSAGES,
} from './constants';

export const ROOM_IDS = ['arrival', 'medical', 'archives', 'reactor', 'exit'] as const;
export const MILESTONES = ['start', 'room_enter', 'relay_restored', 'near_death', 'exit_ready'] as const;
export const DIRECTOR_ACTIONS = ['whisper', 'lights_flicker', 'false_alarm', 'hunt', 'help'] as const;

/**
 * Rejects C0/C1 controls, bidi overrides, line/paragraph separators, and
 * zero-width characters before any text reaches a prompt or a response.
 */
export const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/;

export const roomIdSchema = z.enum(ROOM_IDS);
export const milestoneSchema = z.enum(MILESTONES);
export const directorActionSchema = z.enum(DIRECTOR_ACTIONS);

export const intensitySchema = z.number().min(0).max(1);

const safeInputText = z
  .string()
  .max(MAX_RADIO_MESSAGE_CHARS)
  .refine((value) => !UNSAFE_TEXT_PATTERN.test(value), {
    message: 'text contains disallowed control characters',
  });

const safeOperatorMessage = z
  .string()
  .min(1)
  .max(MAX_OPERATOR_MESSAGE_CHARS)
  .refine((value) => !UNSAFE_TEXT_PATTERN.test(value), {
    message: 'message contains disallowed control characters',
  });

const safeReason = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'reason must be a short lowercase code');

const visitedRoomsSchema = z
  .array(roomIdSchema)
  .max(ROOM_IDS.length)
  .refine((rooms) => new Set(rooms).size === rooms.length, {
    message: 'visitedRooms must not contain duplicates',
  });

/** Strict, bounded request body. Unknown fields are rejected. */
export const directorStateSchema = z.strictObject({
  seed: z
    .number()
    .int()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  // Simulation seconds, with a bounded upper limit.
  elapsed: z.number().min(0).max(86_400_000),
  room: roomIdSchema,
  visitedRooms: visitedRoomsSchema,
  relays: z.number().int().min(0).max(3),
  health: z.number().min(0).max(100),
  flashlight: z.boolean(),
  threat: z.number().min(0).max(1),
  milestone: milestoneSchema,
  recentMessages: z.array(safeInputText).max(MAX_RECENT_MESSAGES),
}) satisfies z.ZodType<DirectorState>;

/** The model may choose only one finite action and a short operator message. */
export const modelDecisionSchema = z.strictObject({
  action: directorActionSchema,
  message: safeOperatorMessage,
}) satisfies z.ZodType<Pick<DirectorEvent, 'action' | 'message'>>;

export const directorEventSchema = z.strictObject({
  action: directorActionSchema,
  room: roomIdSchema,
  message: safeOperatorMessage,
  intensity: intensitySchema,
}) satisfies z.ZodType<DirectorEvent>;

/** Every successful route response is validated against this schema. */
export const directorResponseSchema = z.strictObject({
  source: z.enum(['live', 'fallback']),
  event: directorEventSchema,
  reason: safeReason.optional(),
}) satisfies z.ZodType<DirectorResponse>;

export type ParsedDirectorState = z.infer<typeof directorStateSchema>;
export type ModelDecision = z.infer<typeof modelDecisionSchema>;

const WHITESPACE_OR_UNSAFE =
  /[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]+/g;

/**
 * Collapses line breaks and other control/format characters into single
 * spaces. Validation still runs afterwards, so this cannot smuggle markup or
 * an over-long message past the schema.
 */
export function normalizeOperatorMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(WHITESPACE_OR_UNSAFE, ' ').trim();
}

export const roomIds: readonly RoomId[] = ROOM_IDS;
export const milestones: readonly Milestone[] = MILESTONES;
export const directorActions: readonly DirectorAction[] = DIRECTOR_ACTIONS;
