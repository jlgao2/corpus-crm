import { execSync } from 'node:child_process';

/** First line of `tailscale ip -4` output iff it is actually an IPv4 —
 * a logged-out CLI prints "no current Tailscale IPs; state: NeedsLogin",
 * which must never be handed to listen() as a host. */
export function parseTailscaleIp(out) {
  const first = String(out ?? '').trim().split('\n')[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(first) ? first : null;
}

export function tailscaleIp() {
  try {
    return parseTailscaleIp(execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
  } catch {
    return null;
  }
}
