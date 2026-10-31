'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DirectorEvent,
  DirectorState,
  GameController,
  GameSnapshot,
  SoundCue,
} from '@/shared/contracts';
import { DfSynth } from '@/audio';
import { delay, loadEngineModule } from './engineClient';
import {
  DirectorLink,
  mergeRecent,
  type LinkStatus,
  type RadioMessage,
} from './directorClient';
import BootPanel from './BootPanel';
import Hud, { type FlashBanner } from './Hud';
import Overlays, { type OverlayActions, type OverlayPhase } from './Overlays';
import RadioFeed from './RadioFeed';
import TouchControls from './TouchControls';

type EngineStatus = 'boot' | 'online' | 'offline' | 'error';

const MUTE_STORAGE_KEY = 'dead-frequency:muted';
const MESSAGE_LIMIT = 42;
const FLASH_MS = 3600;

function readStoredMute(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

/**
 * Top-level client shell.
 *
 * Owns (per the plan): menus/HUD/radio, touch controls, Web Audio, and the
 * milestone director fetch. The engine owns simulation/rendering/canvas
 * resizing; the controller is created and destroyed exactly once per mount
 * (strict-mode safe) and snapshots stream in at 10 Hz.
 */
export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<GameController | null>(null);
  const audioRef = useRef<DfSynth | null>(null);
  const mutedRef = useRef(false);
  const runRef = useRef(0);
  const directorRef = useRef<DirectorLink | null>(null);
  const messagesRef = useRef<RadioMessage[]>([]);
  const messageIdRef = useRef(0);
  const flashIdRef = useRef(0);

  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('boot');
  const [engineAttempts, setEngineAttempts] = useState(0);
  const [messages, setMessages] = useState<RadioMessage[]>([]);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>('idle');
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<FlashBanner | null>(null);
  const [isTouch, setIsTouch] = useState(false);

  const phase = snapshot?.phase ?? null;

  // ---------------------------------------------------------------- plumbing

  /** Engine calls must never take the UI down; swallow lifecycle races. */
  const safeCall = useCallback(
    <K extends keyof GameController>(method: K, ...args: Parameters<GameController[K]>) => {
      const controller = controllerRef.current;
      if (!controller) return;
      try {
        (controller[method] as (...callArgs: unknown[]) => void)(...args);
      } catch {
        // Engine not in a callable state (e.g. destroyed during teardown).
      }
    },
    [],
  );

  const pushMessage = useCallback((kind: RadioMessage['kind'], text: string, note?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    messageIdRef.current += 1;
    const entry: RadioMessage = { id: messageIdRef.current, kind, text: trimmed, note };
    const next = [...messagesRef.current.slice(-(MESSAGE_LIMIT - 1)), entry];
    // Milestones can fire synchronously during reset/start, before React
    // commits a render. Keep the callback's transcript current immediately.
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const applyDirectorEvent = useCallback(
    (event: DirectorEvent, kind: 'live' | 'fallback', reason?: string) => {
      flashIdRef.current += 1;
      setFlash({ action: event.action, id: flashIdRef.current });
      pushMessage(
        kind,
        event.message,
        kind === 'fallback' ? reason ?? 'local fallback content' : reason,
      );
      safeCall('applyDirectorEvent', event);
    },
    [pushMessage, safeCall],
  );

  // Stable indirection so the mount-once effect can call the latest handler.
  const applyDirectorEventRef = useRef(applyDirectorEvent);
  useEffect(() => {
    applyDirectorEventRef.current = applyDirectorEvent;
  }, [applyDirectorEvent]);

  // Flash banner auto-clears; resets of the same id never double-schedule.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => {
      setFlash((current) => (current && current.id === flash.id ? null : current));
    }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // ------------------------------------------------------------------- audio

  const ensureAudio = useCallback(() => {
    if (typeof window === 'undefined') return;
    let synth = audioRef.current;
    if (!synth) {
      synth = new DfSynth();
      synth.setMuted(mutedRef.current);
      audioRef.current = synth;
    }
    synth.unlock();
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable; mute still applies for this session.
    }
    if (!next) ensureAudio();
    audioRef.current?.setMuted(next);
  }, [ensureAudio]);

  // Restore the stored mute preference (client only, after hydration).
  useEffect(() => {
    if (readStoredMute()) {
      mutedRef.current = true;
      setMuted(true);
    }
  }, []);

  // Full audio teardown on unmount (strict-mode safe; recreated after remount).
  useEffect(
    () => () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    },
    [],
  );

  // -------------------------------------------------- engine boot + director

  useEffect(() => {
    let disposed = false;

    const link = new DirectorLink({
      deliver: (event, kind, reason) => {
        if (!disposed) applyDirectorEventRef.current(event, kind, reason);
      },
      onLink: (status) => {
        if (!disposed) setLinkStatus(status);
      },
    });
    directorRef.current = link;
    link.newRun(runRef.current);

    void (async () => {
      let hardFaults = 0;
      let attempts = 0;
      while (!disposed) {
        const result = await loadEngineModule();
        if (disposed) return;

        if (result.kind !== 'ok') {
          hardFaults += 1;
          attempts += 1;
          setEngineAttempts(attempts);
          setEngineStatus(hardFaults >= 3 ? 'error' : 'offline');
          if (hardFaults >= 3) return;
          await delay(1400);
          continue;
        }

        const canvas = canvasRef.current;
        if (disposed) return;
        if (!canvas) {
          setEngineStatus('error');
          return;
        }
        try {
          const controller = result.module.createGame(canvas, {
            seed: undefined,
            onSnapshot: (next) => {
              if (!disposed) setSnapshot(next);
            },
            onMilestone: (state: DirectorState) => {
              if (disposed) return;
              // Bound the recent radio context: engine list + UI transcript,
              // deduped, newest last, at most 8 entries.
              const merged: DirectorState = {
                ...state,
                recentMessages: mergeRecent(
                  state.recentMessages ?? [],
                  messagesRef.current.map((message) => message.text),
                ),
              };
              directorRef.current?.submit(merged, runRef.current);
            },
            onSound: (cue: SoundCue) => {
              // No-op until a user gesture created the audio context.
              audioRef.current?.play(cue);
            },
          });
          if (disposed) {
            try {
              controller.destroy();
            } catch {
              // ignore
            }
            return;
          }
          controllerRef.current = controller;
          setEngineStatus('online');
          return;
        } catch {
          // createGame threw mid-lifecycle; treat as a fault and back off.
          hardFaults += 1;
          attempts += 1;
          setEngineAttempts(attempts);
          setEngineStatus(hardFaults >= 3 ? 'error' : 'offline');
          if (hardFaults >= 3) return;
          await delay(1400);
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        controllerRef.current?.destroy();
      } catch {
        // ignore
      }
      controllerRef.current = null;
      // Aborts in-flight director requests for this mount and rejects stale ones.
      link.destroy();
      directorRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------ user actions

  const beginRun = useCallback(() => {
    ensureAudio();
    directorRef.current?.newRun(runRef.current);
    pushMessage('system', 'Carrier locked. Relay restoration begins.');
    safeCall('start');
  }, [ensureAudio, pushMessage, safeCall]);

  const retryRun = useCallback(
    (newSeed: boolean) => {
      ensureAudio();
      runRef.current += 1;
      directorRef.current?.newRun(runRef.current);
      messagesRef.current = [];
      setMessages([]);
      setFlash(null);
      pushMessage('system', `Frequency re-tuned — run ${runRef.current}. The floor forgets nothing.`);
      safeCall('reset', newSeed ? randomSeed() : undefined);
      safeCall('start');
    },
    [ensureAudio, pushMessage, safeCall],
  );

  const chooseEnding = useCallback(
    (ending: 'release' | 'shutdown') => {
      ensureAudio();
      pushMessage(
        'system',
        ending === 'release' ? 'Anchors cut. The choice is made.' : 'Carrier shutdown armed.',
      );
      safeCall('chooseEnding', ending);
    },
    [ensureAudio, pushMessage, safeCall],
  );

  const resumeRun = useCallback(() => safeCall('resume'), [safeCall]);
  const pauseRequest = useCallback(() => safeCall('pause'), [safeCall]);

  const toTitle = useCallback(() => {
    runRef.current += 1;
    directorRef.current?.newRun(runRef.current);
    messagesRef.current = [];
    setMessages([]);
    setFlash(null);
    pushMessage('system', 'Channel open. Sign-on ready.');
    safeCall('reset');
  }, [pushMessage, safeCall]);

  const onVector = useCallback(
    (x: number, y: number, sprint: boolean) => safeCall('setTouchInput', x, y, sprint),
    [safeCall],
  );
  const onInteract = useCallback(() => safeCall('interact'), [safeCall]);
  const onFlashlight = useCallback(() => safeCall('toggleFlashlight'), [safeCall]);

  const overlayActions = useMemo<OverlayActions>(
    () => ({
      begin: beginRun,
      retry: retryRun,
      choose: chooseEnding,
      resume: resumeRun,
      toTitle: toTitle,
    }),
    [beginRun, retryRun, chooseEnding, resumeRun, toTitle],
  );

  // ------------------------------------------------------------ global input

  // UI-owned Escape → pause/resume. Movement keys belong to the engine.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (phase !== 'playing' && phase !== 'paused') return;
      event.preventDefault();
      if (phase === 'playing') {
        safeCall('pause');
      } else {
        safeCall('resume');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, safeCall]);

  // Release touch input when focus is lost; hold the tape when the tab hides.
  useEffect(() => {
    const releaseInput = () => safeCall('setTouchInput', 0, 0, false);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        releaseInput();
        safeCall('pause');
      }
    };
    window.addEventListener('blur', releaseInput);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseInput);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseInput();
    };
  }, [safeCall]);

  // Coarse pointer → touch layer.
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouch(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // ------------------------------------------------------------ first signage

  useEffect(() => {
    pushMessage('system', 'Receiver warm. Dead Frequency interface online.');
  }, [pushMessage]);

  // ----------------------------------------------------------------- render

  const engineReady = engineStatus === 'online' && snapshot !== null;
  const overlayPhase: OverlayPhase | null =
    phase === 'ready' || phase === 'paused' || phase === 'dead' || phase === 'choice' || phase === 'won'
      ? phase
      : null;

  return (
    <div className="df-shell">
      <canvas
        ref={canvasRef}
        className="df-canvas"
        role="img"
        aria-label="Facility view for the current run. Every piece of gameplay state is also presented in the surrounding interface."
      />
      <div className="df-scanlines" aria-hidden />
      <div className="df-vignette" aria-hidden />

      {!engineReady ? (
        <BootPanel
          status={
            engineStatus === 'offline'
              ? 'offline'
              : engineStatus === 'error'
                ? 'error'
                : engineStatus === 'online'
                  ? 'sync'
                  : 'boot'
          }
          attempts={engineAttempts}
        />
      ) : (
        <>
          {snapshot ? (
            <Hud
              snapshot={snapshot}
              linkStatus={linkStatus}
              muted={muted}
              flash={flash}
              onToggleMute={toggleMute}
              onPauseRequest={pauseRequest}
            />
          ) : null}
          <RadioFeed messages={messages} linkStatus={linkStatus} />
          {isTouch && phase === 'playing' ? (
            <TouchControls flashlight={snapshot?.flashlight ?? false} onVector={onVector} onInteract={onInteract} onFlashlight={onFlashlight} />
          ) : null}
          {overlayPhase && snapshot ? (
            <Overlays
              phase={overlayPhase}
              snapshot={snapshot}
              actions={overlayActions}
              muted={muted}
              onToggleMute={toggleMute}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
