import 'server-only';
import { createDirectorPostHandler } from '@/lib/director/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = createDirectorPostHandler({ env: process.env });

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}

/** Explicit method rejection so 405s also carry the no-store/security headers. */
export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
