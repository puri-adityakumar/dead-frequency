'use client';

import { memo } from 'react';

export type BootStatus = 'boot' | 'sync' | 'offline' | 'error';

export interface BootPanelProps {
  status: BootStatus;
  attempts: number;
}

const COPY: Record<BootStatus, string> = {
  boot: 'Establishing carrier — mounting simulation…',
  sync: 'Engine online — waiting for first snapshot…',
  offline: 'Simulation download interrupted. Retrying…',
  error: 'The simulation could not start. Reload to try again.',
};

export default memo(function BootPanel({ status, attempts }: BootPanelProps) {
  return (
    <div className="df-overlay" role="dialog" aria-modal="true" aria-labelledby="df-boot-heading">
      <section className="df-panel" tabIndex={-1} aria-label={COPY[status]}>
        <p className="df-eyebrow">121.3 MHz · carrier open</p>
        <h1 className="df-title" id="df-boot-heading">
          DEAD<span className="df-title__accent">FREQUENCY</span>
        </h1>
        <div className="df-wave" aria-hidden />
        <p className="df-boot__status">
          <span className="df-boot__dot" data-state={status === 'sync' ? 'online' : status} aria-hidden />
          {COPY[status]}
          {status === 'offline' && attempts > 0 ? (
            <span className="df-visually-hidden">Retry attempt {attempts}</span>
          ) : null}
        </p>
        {status === 'error' ? (
          <p className="df-footnote">
            <em>Check your connection and use a browser with Canvas 2D support.</em>
          </p>
        ) : null}
      </section>
    </div>
  );
});
