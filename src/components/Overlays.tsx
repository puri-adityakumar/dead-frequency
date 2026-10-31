'use client';

import { memo, useEffect, useRef } from 'react';
import type { GameSnapshot } from '@/shared/contracts';

export type OverlayPhase = 'ready' | 'paused' | 'dead' | 'choice' | 'won';

export interface OverlayActions {
  begin: () => void;
  retry: (newSeed: boolean) => void;
  choose: (ending: 'release' | 'shutdown') => void;
  resume: () => void;
  toTitle: () => void;
}

export interface OverlaysProps {
  phase: OverlayPhase;
  snapshot: GameSnapshot;
  actions: OverlayActions;
  muted: boolean;
  onToggleMute: () => void;
}

function formatClock(elapsed: number): string {
  const safe = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

const ENDING_COPY = {
  release: {
    title: 'Frequency released',
    copy: 'Anchors cut, the operator\u2019s voice carries past the facility walls. Somewhere out there, it finally gets to speak.',
  },
  shutdown: {
    title: 'Carrier terminated',
    copy: 'The last channel goes quiet behind you. The building keeps its dead, and you keep your distance.',
  },
} as const;

export default memo(function Overlays({ phase, snapshot, actions, muted, onToggleMute }: OverlaysProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Move focus to the primary control when an overlay appears, so keyboard
  // users land inside the dialog instead of on stale focus behind it.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Keep keyboard focus inside the modal rather than tabbing to the hidden
  // HUD. The engine already suspends gameplay in these phases.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex="0"]',
      ));
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapTab);
    return () => document.removeEventListener('keydown', trapTab);
  }, [phase]);

  const winning = phase === 'won' ? snapshot.ending : null;
  const title =
    winning === 'release'
      ? ENDING_COPY.release.title
      : winning === 'shutdown'
        ? ENDING_COPY.shutdown.title
        : '';
  const copy = winning === 'release' ? ENDING_COPY.release.copy : winning === 'shutdown' ? ENDING_COPY.shutdown.copy : '';

  return (
    <div className="df-overlay">
      <section
        ref={panelRef}
        className="df-panel"
        data-accent={
          phase === 'won' ? 'teal' : phase === 'dead' ? 'red' : phase === 'choice' ? 'amber' : 'plain'
        }
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="df-overlay-heading"
      >
        {phase === 'ready' ? (
          <>
            <p className="df-eyebrow">121.3 MHz · carrier open</p>
            <h1 className="df-title" id="df-overlay-heading">
              DEAD<span className="df-title__accent">FREQUENCY</span>
            </h1>
            <p className="df-tagline">
              The last working channel in a dead facility. Three relays are offline. One of its
              residents walks the floors, and it has learned to tell footsteps apart.
            </p>
            <div className="df-wave" aria-hidden />
            <ul className="df-keys" aria-label="Controls">
              <li className="df-keys__row">
                <kbd className="df-kbd">WASD</kbd>
                <span>Move</span>
              </li>
              <li className="df-keys__row">
                <kbd className="df-kbd">Shift</kbd>
                <span>Sprint</span>
              </li>
              <li className="df-keys__row">
                <kbd className="df-kbd">E</kbd>
                <span>Interact</span>
              </li>
              <li className="df-keys__row">
                <kbd className="df-kbd">F</kbd>
                <span>Flashlight</span>
              </li>
              <li className="df-keys__row">
                <kbd className="df-kbd">Esc</kbd>
                <span>Pause</span>
              </li>
              <li className="df-keys__row">
                <kbd className="df-kbd">-touch-</kbd>
                <span>On-screen stick</span>
              </li>
            </ul>
            <div className="df-actions">
              <button type="button" className="df-btn df-btn--primary" data-autofocus onClick={actions.begin}>
                Begin transmission
              </button>
              <button type="button" className="df-btn df-btn--ghost" onClick={onToggleMute} aria-pressed={muted}>
                {muted ? 'Sound: off — turn on' : 'Sound: on'}
              </button>
            </div>
            <p className="df-footnote">
              Restore all three relays, then decide the fate of the voice on the line.
              <br />
              <em>Audio starts with your input. All art and sound are generated in your browser.</em>
            </p>
          </>
        ) : null}

        {phase === 'paused' ? (
          <>
            <p className="df-eyebrow">Feed held</p>
            <h2 className="df-heading" id="df-overlay-heading">
              Feed paused
            </h2>
            <p className="df-copy">
              The carrier holds. Threats keep their distance while the tape stands still; the
              hallway does not forgive complacency when you let it roll again.
            </p>
            <div className="df-actions">
              <div className="df-actions__row">
                <button type="button" className="df-btn df-btn--primary" data-autofocus onClick={actions.resume}>
                  Resume
                </button>
                <button type="button" className="df-btn df-btn--ghost" onClick={() => actions.retry(false)}>
                  Restart run
                </button>
                <button type="button" className="df-btn df-btn--ghost" onClick={actions.toTitle}>
                  Return to feed sign-on
                </button>
              </div>
              <button type="button" className="df-btn df-btn--ghost" onClick={onToggleMute} aria-pressed={muted}>
                {muted ? 'Sound: off — turn on' : 'Sound: on'}
              </button>
            </div>
          </>
        ) : null}

        {phase === 'dead' ? (
          <>
            <p className="df-eyebrow">End of transmission</p>
            <h2 className="df-heading df-title--dead" id="df-overlay-heading">
              Signal lost
            </h2>
            <p className="df-copy">
              Footsteps answered yours, then the corridor carried the rest. The tape stops here —
              the next voice on this channel can still be yours.
            </p>
            <div className="df-stats">
              <div className="df-stats__item">
                <span className="df-stats__value">{formatClock(snapshot.elapsed)}</span>
                <span className="df-stats__label">Survived</span>
              </div>
              <div className="df-stats__item">
                <span className="df-stats__value">{snapshot.relays}/3</span>
                <span className="df-stats__label">Relays</span>
              </div>
              <div className="df-stats__item">
                <span className="df-stats__value">{snapshot.seed}</span>
                <span className="df-stats__label">Seed</span>
              </div>
            </div>
            <div className="df-actions">
              <div className="df-actions__row">
                <button type="button" className="df-btn df-btn--primary" data-autofocus onClick={() => actions.retry(false)}>
                  Try again · same seed
                </button>
                <button type="button" className="df-btn" onClick={() => actions.retry(true)}>
                  New frequency
                </button>
              </div>
              <button type="button" className="df-btn df-btn--ghost" onClick={actions.toTitle}>
                Return to sign-on
              </button>
            </div>
          </>
        ) : null}

        {phase === 'choice' ? (
          <>
            <p className="df-eyebrow">The line is open</p>
            <h2 className="df-heading" id="df-overlay-heading">
              The operator waits
            </h2>
            <p className="df-copy">
              Every relay answers. The voice on the channel has nothing left between it and the
              dark — except whatever you decide for it now. This chooses how the run ends.
            </p>
            <div className="df-choice">
              <button
                type="button"
                className="df-choice__card df-choice__card--release"
                data-autofocus
                onClick={() => actions.choose('release')}
              >
                <span className="df-choice__label">Release it</span>
                <span className="df-choice__desc">
                  Cut the anchors. Let it answer the last call on its own frequency — whatever
                  that turns out to be.
                </span>
              </button>
              <button
                type="button"
                className="df-choice__card df-choice__card--shutdown"
                onClick={() => actions.choose('shutdown')}
              >
                <span className="df-choice__label">Shut it down</span>
                <span className="df-choice__desc">
                  Kill the carrier. End every voice on the line, take the exit, and leave the
                  building its silence.
                </span>
              </button>
            </div>
          </>
        ) : null}

        {phase === 'won' ? (
          <>
            <p className="df-eyebrow">Run complete</p>
            <h2 className="df-heading df-title--teal" id="df-overlay-heading">
              {title}
            </h2>
            <p className="df-copy">{copy}</p>
            <div className="df-stats">
              <div className="df-stats__item">
                <span className="df-stats__value">{formatClock(snapshot.elapsed)}</span>
                <span className="df-stats__label">Duration</span>
              </div>
              <div className="df-stats__item">
                <span className="df-stats__value">3/3</span>
                <span className="df-stats__label">Relays</span>
              </div>
            </div>
            <div className="df-actions">
              <div className="df-actions__row">
                <button type="button" className="df-btn df-btn--primary" data-autofocus onClick={() => actions.retry(true)}>
                  New frequency
                </button>
                <button type="button" className="df-btn" onClick={() => actions.retry(false)}>
                  Replay same seed
                </button>
              </div>
              <button type="button" className="df-btn df-btn--ghost" onClick={actions.toTitle}>
                Return to sign-on
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
});
