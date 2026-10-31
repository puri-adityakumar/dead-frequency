import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dead Frequency — survival on the last working channel',
  description:
    'A 2.5D canvas survival-horror run. Restore three relays in a dead facility, avoid the thing on the floor, then decide the fate of the voice on the line.',
  applicationName: 'Dead Frequency',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#05070a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="df-body">{children}</body>
    </html>
  );
}
