'use client';

import { memo } from 'react';
import type { DirectorAction, GameSnapshot, RoomId } from '@/shared/contracts';
import type { LinkStatus } from './directorClient';

const ROOM_LABEL: Record<RoomId, string> = {
  arrival: 'Arrival bay',
  medical: 'Medical ward',
  archives: 'Archives',
  reactor: 'Reactor floor',
  exit: 'Exit shaft',
};

const LINK_TEXT: Record<LinkStatus, string> = {
  idle: 'Director · standby',
  live: 'Director · live',
  fallback: 'Director · fallback',
};

const LINK_TEXT_A11Y: Record<LinkStatus, string> = {
  idle: 'Director link: standby. No transmission requested yet.',
  live: 'Director link: live operator connected.',
  fallback: 'Director link: running local fallback content.',
};

const FLASH: Record<DirectorAction, { text: string; tone: 'amber' | 'red' | 'teal' | 'dim' }> = {
  whisper: { text: 'A whisper crosses the line', tone: 'dim' },
  lights_flicker: { text: 'Lighting fluctuation', tone: 'amber' },
  false_alarm: { text: 'False alarm on the floor', tone: 'amber' },
  hunt: { text: 'Something is hunting — move', tone: 'red' },
  help: { text: 'The director marks a route', tone: 'teal' },
};

export interface FlashBanner {
  action: DirectorAction;
  id: number;
}

export interface HudProps {
  snapshot: GameSnapshot;
  linkStatus: LinkStatus;
  muted: boolean;
  flash: FlashBanner | null;
  onToggleMute: () => void;
  onPauseRequest: () => void;
}

function formatClock(elapsed: number): string {
  const safe = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const Bar = memo(function Bar(props: {
  label: string;
  value: number;
  tone: 'teal' | 'amber' | 'red' | 'dim';
}) {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <div className="df-bar" data-tone={props.tone}>
      <span className="df-bar__label">{props.label}</span>
      <span
        className="df-bar__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={props.label}
      >
        <span className="df-bar__fill" style={{ width: `${pct}%` }} />
        <span className="df-bar__ticks" aria-hidden />
      </span>
      <span className="df-bar__value" aria-hidden>
        {String(pct).padStart(3, '0')}%
      </span>
    </div>
  );
});

export default memo(function Hud({ snapshot, linkStatus, muted, flash, onToggleMute, onPauseRequest }: HudProps) {
  const { seed, health, stamina, threat, relays, room, elapsed, interaction, phase, flashlight } = snapshot;
  const playing = phase === 'playing';
  const flashInfo = flash ? FLASH[flash.action] : null;

  return (
    <div className="df-hud">
      <header className="df-hud__top">
        <span className="df-chip">
          <strong>DEAD FREQ</strong>
        </span>
        <span className="df-chip df-chip--seed">
          <strong>SEED {seed}</strong>
        </span>
        <span className="df-chip df-chip--location">
          <span className="df-chip__room">{ROOM_LABEL[room]}</span>
          <span className="df-chip__clock" aria-hidden>
            ▸
          </span>
          <span className="df-chip__clock">{formatClock(elapsed)}</span>
          <span className="df-visually-hidden">
            {ROOM_LABEL[room]}, elapsed {formatClock(elapsed)}
          </span>
        </span>
        <span
          className="df-chip df-chip--lamp"
          data-state={flashlight ? 'on' : 'off'}
          role="status"
          aria-label={`Flashlight: ${flashlight ? 'on' : 'off'}`}
        >
          LAMP {flashlight ? 'ON' : 'OFF'}
        </span>
        <span className="df-spacer" />
        {/*
          Link badge: never claims "live" before a real response arrives.
          'standby' is the honest pre-request state.
        */}
        <span
          className="df-badge"
          data-state={linkStatus}
          role="status"
          aria-label={LINK_TEXT_A11Y[linkStatus]}
        >
          <span className="df-badge__lamp" aria-hidden />
          {LINK_TEXT[linkStatus]}
        </span>
        <button
          type="button"
          className="df-iconbtn"
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute audio' : 'Mute audio'}
        >
          {muted ? 'UNMUTE' : 'MUTE'}
        </button>
        {playing ? (
          <button
            type="button"
            className="df-iconbtn"
            onClick={onPauseRequest}
            aria-label="Pause the run (Escape)"
          >
            PAUSE
          </button>
        ) : null}
      </header>

      <section className="df-vitals" aria-label="Vitals">
        <Bar label="Integrity" value={health} tone={health < 0.35 ? 'red' : 'teal'} />
        <Bar label="Stamina" value={stamina} tone="amber" />
        <Bar label="Threat" value={threat} tone={threat > 0.66 ? 'red' : threat > 0.33 ? 'amber' : 'dim'} />
        <div className="df-relays">
          <span className="df-relays__label">Relays</span>
          <span data-relay-pips aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className={`df-relays__pip${i < relays ? ' is-on' : ''}`} />
            ))}
          </span>
          <span className="df-visually-hidden">{`Relays restored: ${relays} of 3`}</span>
        </div>
      </section>

      {flashInfo ? (
        <div
          className="df-flash"
          data-tone={flashInfo.tone}
          role="status"
          aria-live="polite"
        >
          {flashInfo.text}
        </div>
      ) : (
        <div className="df-flash" role="status" aria-live="polite" aria-hidden>
          {''}
        </div>
      )}

      {playing && interaction ? (
        <div className="df-prompt">
          <kbd className="df-kbd df-key-hint" aria-hidden>
            [E]
          </kbd>
          <span>{interaction.replace(/\s*\[E\]$/, '')}</span>
          <span className="df-visually-hidden">Interaction available: {interaction}</span>
        </div>
      ) : null}
    </div>
  );
});
