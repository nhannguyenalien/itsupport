#!/usr/bin/env python3
"""Fill the Coolify application's environment variables from the macmini deployment.

Run on a machine that can `ssh mac@macmini` (BatchMode) and reach the Coolify API:

    CT='<Coolify API token>' AUUID='<application uuid>' python3 infra/coolify/fill-env.py

Reads infra/.env and infra/secrets/* on macmini, rewrites the public URLs to the
new domain, generates the bundled-db passwords, and PATCHes everything to
Coolify in one bulk call. Secret values are never printed (only key names).
The token needs write permission; revoke it afterwards.

Optional: DOMAIN (default https://itsupports.schoolsai.work), MACMINI (default
mac@macmini), COOLIFY_API (default https://cool.schoolsai.work/api/v1).
"""
import json
import os
import secrets
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

TOKEN = os.environ["CT"]
APP = os.environ["AUUID"]
API = os.environ.get("COOLIFY_API", "https://cool.schoolsai.work/api/v1")
DOMAIN = os.environ.get("DOMAIN", "https://itsupports.schoolsai.work").rstrip("/")
MACMINI = os.environ.get("MACMINI", "mac@macmini")
BASE = "/home/mac/apps/itsupport/infra"
SECRET_VALUES = []


def remote(cmd):
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", MACMINI, cmd],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        sys.exit("ssh failed: " + out.stderr.strip()[:200])
    return out.stdout


def tls_context():
    """python.org builds on macOS ship without root certificates; use the system bundle."""
    ctx = ssl.create_default_context()
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(bundle):
            ctx.load_verify_locations(bundle)
            break
    return ctx


TLS = tls_context()
dotenv = {}
for line in remote(f"cat {BASE}/.env").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        dotenv[k.strip()] = v.strip().strip('"').strip("'")


def b64(name):
    return remote(f"base64 -w0 {BASE}/secrets/{name}").strip()


def txt(name):
    return remote(f"cat {BASE}/secrets/{name}").strip()


print("old APP_PUBLIC_URL   :", dotenv.get("APP_PUBLIC_URL"))
print("old AGENT_PUBLIC_URL :", dotenv.get("AGENT_PUBLIC_URL"))

env = {}
for k in ["OAUTH_STATE_SECRET", "OAUTH_TOKEN_ENC_KEY", "OPENAI_API_KEY", "FIREBASE_PROJECT_ID",
          "NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_APP_ID", "MESHCENTRAL_URL",
          "MESHCENTRAL_TENANT_GROUPS", "MESHCENTRAL_API_USER", "MESHCENTRAL_API_PASSWORD",
          "MESHCENTRAL_LINUX_TENANT_GROUPS", "SCHOOLSAI_API_URL", "SCHOOLSAI_API_KEY"]:
    if dotenv.get(k):
        env[k] = dotenv[k]
env["APP_PUBLIC_URL"] = DOMAIN
env["CORS_ORIGINS"] = DOMAIN
env["AGENT_PUBLIC_URL"] = DOMAIN + "/api"
env["FIREBASE_ADMIN_JSON_B64"] = b64("firebase-admin.json")
env["AGENT_CA_CERT_B64"] = b64("agent-ca.crt")
env["AGENT_CA_KEY_B64"] = b64("agent-ca.key")
# Production runs against Neon (docker-compose.neon.yml): reuse it, no data move.
env["EXTERNAL_DATABASE_URL"] = txt("neon_database_url")
env["EXTERNAL_DATABASE_ADMIN_URL"] = txt("neon_database_admin_url")
env["NODE_OPTIONS"] = "--dns-result-order=ipv4first --no-network-family-autoselection"
# The bundled db service still starts; it is unused while EXTERNAL_* is set.
env["DB_ADMIN_PASSWORD"] = secrets.token_hex(24)
env["DB_APP_PASSWORD"] = secrets.token_hex(24)

d = DOMAIN + "/downloads/agent/"
env.update({
    "RESTIC_WINDOWS_URL": d + "restic-windows-amd64.exe",
    "RESTIC_WINDOWS_SHA256": "b0dd1fd21eea5d8fe1325f55f7118213c21f36de8a261e04c0624a5ab9fd7830",
    "RESTIC_LINUX_AMD64_URL": d + "restic-linux-amd64.bz2",
    "RESTIC_LINUX_AMD64_SHA256": "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
    "RESTIC_LINUX_ARM64_URL": d + "restic-linux-arm64.bz2",
    "RESTIC_LINUX_ARM64_SHA256": "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
    "RESTIC_DARWIN_AMD64_URL": d + "restic-darwin-amd64.bz2",
    "RESTIC_DARWIN_AMD64_SHA256": "c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35",
    "RESTIC_DARWIN_ARM64_URL": d + "restic-darwin-arm64.bz2",
    "RESTIC_DARWIN_ARM64_SHA256": "7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143",
})

for k in ["OAUTH_TOKEN_ENC_KEY", "OAUTH_STATE_SECRET", "OPENAI_API_KEY", "SCHOOLSAI_API_KEY", "MESHCENTRAL_API_PASSWORD",
          "FIREBASE_ADMIN_JSON_B64", "AGENT_CA_KEY_B64", "EXTERNAL_DATABASE_URL", "EXTERNAL_DATABASE_ADMIN_URL",
          "DB_ADMIN_PASSWORD", "DB_APP_PASSWORD"]:
    if env.get(k):
        SECRET_VALUES.append(env[k])


def scrub(text):
    for s in SECRET_VALUES:
        text = text.replace(s, "***")
    return text


# Build-time: baked into the frontend bundle. Everything else is runtime only.
BUILD = {"NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_APP_ID", "FIREBASE_PROJECT_ID"}
data = [{"key": k, "value": v, "is_preview": False, "is_literal": True, "is_multiline": False,
         "is_buildtime": k in BUILD, "is_runtime": True} for k, v in env.items()]


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=TLS) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("Coolify HTTP %s: %s" % (e.code, scrub(e.read().decode())[:300]))


status, _ = call("PATCH", f"/applications/{APP}/envs/bulk", {"data": data})
print("bulk update HTTP", status, "| keys sent:", len(data))
print("keys:", ", ".join(sorted(env)))
absent = [k for k in ["OAUTH_TOKEN_ENC_KEY", "FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_API_KEY",
                      "NEXT_PUBLIC_FIREBASE_APP_ID"] if k not in env]
print("missing from macmini .env:", absent or "none")

# Verify without printing values: none empty, none a leftover "set <NAME>" placeholder
# (Coolify derives those from `${VAR:?message}` in the compose file).
_, live = call("GET", f"/applications/{APP}/envs")
bad = sorted({e["key"] for e in live if not e.get("is_preview") and e["key"] in env
              and (not e.get("value") or e["value"].startswith("set "))})
print("keys still empty/placeholder:", bad or "none")
