# MeshCentral + step-ca (Coolify deployment)

Deployed 2026-09-02 on the user's own Coolify instance at `cool.toidayhoc.com`,
project `support-agent-infra` (uuid `oplxknzd4yt0ue8iaxq7q0zg`), NOT on the
observer_system trading VPS — kept off that box deliberately (it's low on
free RAM/disk and hosts other tenants + the live trading bot).

## Services

| Service | Coolify app uuid | Public URL | Container status |
|---|---|---|---|
| MeshCentral | `qaezeghl2zpls8kgpph2xvv6` | https://support-agent-mesh.toidayhoc.com | running, real cert generated for this hostname, `tlsOffload`+`trustedProxy` on (serves plain HTTP internally, Traefik terminates TLS) |
| step-ca | `ldyfgnx0zgm6ykzh17b67tbt` | https://support-agent-ca.toidayhoc.com | running:healthy, real root+intermediate CA generated, fingerprint in `.env.meshcentral-ca` |

Both have persistent volumes attached (`/home/step` for step-ca,
`/opt/meshcentral/meshcentral-data` + `meshcentral-files` for MeshCentral) so
data survives redeploys/restarts.

## Known-good, actually verified

- Both containers build and run cleanly (checked via Coolify's deployment
  logs and `status` field, not just "deploy succeeded").
- step-ca generated a real root CA and is serving HTTPS on its internal port
  — confirmed from its own boot log, not assumed.
- MeshCentral generated a real cert for `support-agent-mesh.toidayhoc.com`
  (had to fix this explicitly — it defaults to a placeholder hostname and
  needs `HOSTNAME` + `DYNAMIC_CONFIG=true` env vars to pick up the real one).
- MeshCentral has no users yet — first account created via the web UI becomes
  site admin. Deliberately did not create this account; that's the user's to
  create.
- DNS: `*.toidayhoc.com` is proxied through Cloudflare (per the user) and
  resolves correctly to both apps' hostnames.

## Open issue — NOT resolved, needs the user's Cloudflare access

Both public URLs currently return an HTTP 302 redirecting to themselves
(`Location: https://<same-host>/`), served with `server: cloudflare` and no
other identifying headers, and — critically — **identical regardless of
origin-side changes** (tried MeshCentral both TLS-native and with
`tlsOffload` on; response didn't change at all). That strongly suggests the
redirect is happening at Cloudflare's edge, not reaching Traefik/the
containers, but this could not be confirmed without dashboard/API access to
the Cloudflare zone, which this session doesn't have.

Most likely causes, roughly in order of likelihood:
1. A Cloudflare Redirect Rule / Page Rule on the `toidayhoc.com` zone that
   matches these new subdomains and loops them back to themselves.
2. Zone-wide "Always Use HTTPS" or "Automatic HTTPS Rewrites" interacting
   oddly with a new hostname that has no rule of its own yet.
3. (Less likely, since `cool.toidayhoc.com` itself works fine end-to-end
   through the same Cloudflare zone) an SSL/TLS mode mismatch.

**Next step**: check Cloudflare dashboard → `toidayhoc.com` zone → Rules
(Redirect Rules / Page Rules) and SSL/TLS → Overview, for anything matching
`support-agent-*` or wildcard `*.toidayhoc.com`. Once that's sorted, both
URLs should just work — nothing further needed on the Coolify/container side
for that part.

## Still to do once reachable

- User creates the first MeshCentral account (becomes site admin).
- Wire `MESHCENTRAL_URL` / CA config into `backend/.env` for the actual
  takeover-fallback and mTLS-enrollment integration (not done yet — no
  reachable endpoint to test against until the redirect issue above is
  fixed).
