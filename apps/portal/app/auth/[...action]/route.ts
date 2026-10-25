import { handle } from '@innoview/identity-bff';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handle('portal', request);
}
export function POST(request: Request) {
  return handle('portal', request);
}
