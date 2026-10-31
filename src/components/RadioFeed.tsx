'use client';

import { memo, useEffect, useRef } from 'react';
import type { LinkStatus, RadioMessage } from './directorClient';

const LINK_BADGE: Record<LinkStatus, string> = {
  idle: 'Standby',
  live: 'Live AI',
  fallback: 'Fallback',
};

export interface RadioFeedProps {
  messages: readonly RadioMessage[];
  linkStatus: LinkStatus;
}

/**
 * Rolling radio transcript. Every entry carries an explicit source tag:
 * LIVE (server responses), FALLBACK (in-house scripted content — never
 * presented as live AI), and SYS (local UI notices, never fake transmissions).
 */
export default memo(function RadioFeed({ messages, linkStatus }: RadioFeedProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the tail visible only when the reader is already at the bottom, so
  // someone scrolling the history up is not yanked down by the next message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <aside className="df-radio" aria-label="Radio transcript">
      <div className="df-radio__head">
        <span className="df-radio__title">Radio ▸ 121.3 DEAD</span>
        <span className="df-badge" data-state={linkStatus} aria-hidden>
          <span className="df-badge__lamp" />
          {LINK_BADGE[linkStatus]}
        </span>
      </div>
      <div className="df-radio__scroll" ref={scrollRef}>
        <ol className="df-radio__list" aria-live="polite" aria-relevant="additions">
          {messages.map((message) => (
            <li key={message.id} className={`df-msg df-msg--${message.kind}`}>
              <span className="df-msg__tag" aria-hidden>
                {message.kind === 'live' ? 'LIVE' : message.kind === 'fallback' ? 'FALLBACK' : 'SYS'}
              </span>
              <span className="df-msg__text">
                {message.text}
                {message.note ? <em className="df-msg__note">{message.note}</em> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
});
