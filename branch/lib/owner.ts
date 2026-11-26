/**
 * The owner's proof, for the brain (root/src/owner.rs).
 *
 * The brain cannot see the phone: it sees this app, over loopback, like every local process. What it
 * CAN check is a paired device's credential against the registry (hashes only on disk): so the app
 * hands it the raw token of a live device, and only that — never a claim. Two uses:
 *   - `mintVoucher`: the owner's message is sent with a one-time voucher; the brain stamps the
 *     stored message as typed by the owner, which is what lets MAIN pass it on by reference.
 *   - `approve` (app/api/session/[id]/approve): the Approve button; the token rides to the brain.
 * Admin token, the box console and tailnet trust are NOT a device (`deviceOf`): the console is
 * where agents' tools run, so it never counts as the owner.
 */
import { cookieOf, bearerOf, deviceOf } from '@/lib/admin';
import { OC } from '@/lib/oc';

export const DEVICE_HEADER = 'x-ygg-device';
export const VOUCHER_HEADER = 'x-ygg-owner-voucher';

/** The raw credential of a live paired device on this request, or '' (console, admin, tailnet, nobody). */
export async function ownerToken(req: Request): Promise<string> {
  if (!(await deviceOf(req))) return '';
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  return presented && presented !== expected ? presented : cookieOf(req, 'bifrost_device');
}

/** A one-time voucher for the owner's next message, or undefined (no device here, or the brain
 *  refuses). Never throws: an owner message without a voucher is still sent, just not provable. */
export async function mintVoucher(req: Request): Promise<string | undefined> {
  const token = await ownerToken(req);
  if (!token) return undefined;
  try {
    const r = await fetch(`${OC}/owner/voucher`, {
      method: 'POST',
      cache: 'no-store',
      headers: { [DEVICE_HEADER]: token },
    });
    if (!r.ok) return undefined;
    const d = (await r.json()) as { voucher?: unknown };
    return typeof d.voucher === 'string' ? d.voucher : undefined;
  } catch {
    return undefined;
  }
}
