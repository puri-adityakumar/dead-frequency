'use client';

import { memo, useCallback, useEffect, useRef } from 'react';

export interface TouchControlsProps {
  flashlight: boolean;
  /** Movement axes for setTouchInput. Convention: up on the stick = negative y (screen-space). If the engine expects forward-positive y, it negates on its boundary. */
  onVector: (x: number, y: number, sprint: boolean) => void;
  onInteract: () => void;
  onFlashlight: () => void;
}

const DEADZONE = 0.18;

/**
 * Coarse-pointer controls: a left thumbstick mapped through
 * GameController.setTouchInput, plus hold-to-sprint and tap action buttons.
 * Input is released on pointer cancel, losing capture, and on window blur
 * (the shell also calls release globally). No keyboard dependency.
 */
export default memo(function TouchControls({ flashlight, onVector, onInteract, onFlashlight }: TouchControlsProps) {
  const stickRef = useRef<HTMLDivElement | null>(null);
  const nubRef = useRef<HTMLDivElement | null>(null);
  const pointerId = useRef<number | null>(null);
  const vector = useRef({ x: 0, y: 0 });
  const sprint = useRef(false);
  const sprintPointer = useRef<number | null>(null);
  const sprintRef = useRef<HTMLButtonElement | null>(null);

  const push = useCallback(() => {
    onVector(vector.current.x, vector.current.y, sprint.current);
  }, [onVector]);

  const resetNub = useCallback(() => {
    const nub = nubRef.current;
    if (nub) nub.style.transform = 'translate(-50%, -50%)';
  }, []);

  const releaseStick = useCallback(
    (event: { pointerId: number }) => {
      if (pointerId.current !== event.pointerId) return;
      pointerId.current = null;
      vector.current = { x: 0, y: 0 };
      resetNub();
      push();
    },
    [push, resetNub],
  );

  const moveStick = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const stick = stickRef.current;
      const nub = nubRef.current;
      if (!stick || !nub || pointerId.current !== event.pointerId) return;

      const rect = stick.getBoundingClientRect();
      const radius = rect.width / 2;
      let dx = (event.clientX - (rect.left + radius)) / radius;
      let dy = (event.clientY - (rect.top + radius)) / radius;
      const rawMagnitude = Math.hypot(dx, dy);
      const magnitude = Math.min(1, rawMagnitude);
      if (rawMagnitude > 1) {
        dx /= rawMagnitude;
        dy /= rawMagnitude;
      }

      let x = 0;
      let y = 0;
      if (magnitude > DEADZONE) {
        const scaled = Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE));
        x = (dx / Math.max(magnitude, Number.EPSILON)) * scaled;
        y = (dy / Math.max(magnitude, Number.EPSILON)) * scaled;
      }
      vector.current = { x, y };
      // Visual nub stays inside the well; translate from the centered origin.
      nub.style.transform = `translate(calc(-50% + ${(dx * radius * 0.52).toFixed(1)}px), calc(-50% + ${(dy * radius * 0.52).toFixed(1)}px))`;
      push();
    },
    [push],
  );

  // Release everything if the tab loses focus mid-drag.
  useEffect(() => {
    const release = () => {
      if (pointerId.current !== null) {
        pointerId.current = null;
        vector.current = { x: 0, y: 0 };
        resetNub();
        sprint.current = false;
        sprintPointer.current = null;
        if (sprintRef.current) sprintRef.current.classList.remove('is-sprinting');
        onVector(0, 0, false);
      } else if (sprint.current) {
        sprint.current = false;
        sprintPointer.current = null;
        if (sprintRef.current) sprintRef.current.classList.remove('is-sprinting');
        onVector(vector.current.x, vector.current.y, false);
      }
    };
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('blur', release);
      release();
    };
  }, [onVector, resetNub]);

  const onStickDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== null) return;
    pointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveStick(event);
  };

  const onSprintDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    sprint.current = true;
    sprintPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (sprintRef.current) sprintRef.current.classList.add('is-sprinting');
    push();
  };

  const onSprintUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (sprintPointer.current !== event.pointerId) return;
    sprint.current = false;
    sprintPointer.current = null;
    if (sprintRef.current) sprintRef.current.classList.remove('is-sprinting');
    push();
  };

  const preventPointer = (event: React.PointerEvent) => event.preventDefault();
  const blockMenu = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="df-touch is-active" aria-label="Touch controls">
      <div
        ref={stickRef}
        className="df-stick"
        role="application"
        aria-label="Movement stick. Drag from center to move."
        onPointerDown={onStickDown}
        onPointerMove={moveStick}
        onPointerUp={releaseStick}
        onPointerCancel={releaseStick}
        onLostPointerCapture={releaseStick}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div ref={nubRef} className="df-stick__nub" />
      </div>

      <div className="df-touch__btns">
        <button
          ref={sprintRef}
          type="button"
          className="df-tbtn df-tbtn--sprint"
          onPointerDown={onSprintDown}
          onPointerUp={onSprintUp}
          onPointerCancel={onSprintUp}
          onLostPointerCapture={onSprintUp}
          onContextMenu={blockMenu}
          aria-label="Hold to sprint"
        >
          SPRINT
          <span aria-hidden>hold</span>
        </button>
        <button
          type="button"
          className="df-tbtn df-tbtn--lamp"
          onPointerDown={preventPointer}
          onClick={onFlashlight}
          onContextMenu={blockMenu}
          aria-label="Toggle flashlight"
          aria-pressed={flashlight}
        >
          LAMP
          <span aria-hidden>flash</span>
        </button>
        <button
          type="button"
          className="df-tbtn df-tbtn--interact"
          onPointerDown={preventPointer}
          onClick={onInteract}
          onContextMenu={blockMenu}
          aria-label="Interact"
        >
          USE
          <span aria-hidden>interact</span>
        </button>
      </div>
    </div>
  );
});
