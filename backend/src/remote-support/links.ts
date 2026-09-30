import { z } from "zod";

// MeshCentral uses a 48-byte node identifier, encoded as hex or modified base64.
export const meshNodeId = z.string().trim().regex(/^(?:[a-fA-F0-9]{96}|[A-Za-z0-9@$]{64})$/);
export function remoteConsoleUrl(): string | null {
  const value = process.env.MESHCENTRAL_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid MeshCentral URL");
  return url.origin;
}
export function remoteDeviceUrl(nodeId: string): string {
  const base = remoteConsoleUrl();
  if (!base) throw new Error("MeshCentral is not configured");
  const url = new URL(base);
  url.searchParams.set("gotonode", meshNodeId.parse(nodeId));
  url.searchParams.set("viewmode", "11");
  return url.toString();
}
