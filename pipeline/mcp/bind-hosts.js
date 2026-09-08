// Which interfaces the HTTP (hypertext transfer protocol) listener binds.
//
// This used to be inlined in mcp-server.js as
//   ['127.0.0.1', tailscaleIp()].filter(Boolean)
// which meant every HTTP-mode start also published the server on the host's
// Tailscale address, on any port. On the laptop that is unwanted reach: the
// server there is only ever used locally, and a tailnet listener bypasses
// `tailscale serve` entirely, so no serve config can mitigate it. The
// homelab genuinely needs the tailnet bind — that is how Excalibur's `crm`
// spellbook reaches it — so the reach becomes opt-in rather than automatic.
//
// Set MCP_BIND_TAILNET=1 on the host that should be reachable over the
// tailnet. Everything else stays loopback-only.

export const TAILNET_ENV = 'MCP_BIND_TAILNET';

/**
 * @param {object} opts
 * @param {object} opts.env            environment to read (defaults to process.env)
 * @param {() => string} opts.resolveTailscaleIp  returns this host's tailnet IP, or falsy
 * @returns {string[]} interfaces to bind, loopback always first
 */
export function bindHosts({ env = process.env, resolveTailscaleIp } = {}) {
  const hosts = ['127.0.0.1'];
  if (env[TAILNET_ENV] !== '1') return hosts;
  let ip = '';
  try {
    ip = resolveTailscaleIp ? resolveTailscaleIp() : '';
  } catch {
    ip = '';   // tailscale absent or failing is not a reason to refuse to start
  }
  if (ip && ip !== '127.0.0.1') hosts.push(ip);
  return hosts;
}
