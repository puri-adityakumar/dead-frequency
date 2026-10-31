import GameShell from '@/components/GameShell';

export default function Page() {
  return (
    <main className="df-app" id="df-root" aria-label="Dead Frequency">
      {/*
        The game shell is fully client-side: it mounts the engine canvas once per
        session, owns the HUD/menus/audio/touch layer, and talks to the same-origin
        director endpoint at milestones only. Nothing here blocks on the network.
      */}
      <GameShell />
      <noscript>
        <div className="df-noscript" role="note">
          DEAD FREQUENCY needs JavaScript to tune into the carrier. Enable scripting and
          reload this page to begin the run.
        </div>
      </noscript>
    </main>
  );
}
