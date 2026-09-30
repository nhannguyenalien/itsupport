import { z } from 'zod';
import { meshNodeId, remoteConsoleUrl } from './links.js';

// Explicit tenant assignments prevent enrollment into another customer's group.
export function remoteInstall(tenantId: string, platform: string) {
  const base = remoteConsoleUrl();
  const groups = z.record(z.string().uuid(), meshNodeId).parse(JSON.parse(process.env.MESHCENTRAL_TENANT_GROUPS || '{}'));
  const group = groups[tenantId];
  if (!base || !group) return null;
  const url = new URL(platform === 'mac' ? '/meshosxagent' : '/meshagents', base);
  url.searchParams.set('id', platform === 'mac' ? '10005' : '4');
  url.searchParams.set('meshid', group);
  return { url: url.toString(), server: base, group, platform };
}
