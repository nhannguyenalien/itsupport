import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function issueDeviceCertificate(deviceId: string, publicKeyPem: string) {
  const caCertPath = process.env.AGENT_CA_CERT_PATH;
  const caKeyPath = process.env.AGENT_CA_KEY_PATH;
  if (!caCertPath || !caKeyPath) throw new Error("agent CA paths are not configured");

  const serial = randomBytes(20).toString("hex");
  const dir = await mkdtemp(join(tmpdir(), "agent-cert-"));
  try {
    const publicKeyPath = join(dir, "public.pem");
    const certPath = join(dir, "client.pem");
    const extensionPath = join(dir, "extensions.cnf");
    await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 });
    await writeFile(extensionPath, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=critical,clientAuth",
      `subjectAltName=URI:urn:itsupport:device:${deviceId}`,
    ].join("\n"), { mode: 0o600 });
    await execFileAsync("openssl", [
      "x509", "-new", "-force_pubkey", publicKeyPath,
      "-subj", `/CN=${deviceId}`,
      "-CA", caCertPath, "-CAkey", caKeyPath,
      "-set_serial", `0x${serial}`, "-days", "90", "-sha256",
      "-extfile", extensionPath, "-out", certPath,
    ]);
    return {
      serial,
      certificatePem: await readFile(certPath, "utf8"),
      caCertificatePem: await readFile(caCertPath, "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
