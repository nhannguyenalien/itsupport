import { z } from 'zod';
import { meshNodeId, remoteConsoleUrl } from './links.js';

// Explicit tenant assignments prevent enrollment into another customer's group.
export function remoteInstall(tenantId: string, platform: string, arch?: 'amd64' | 'arm64') {
  if (!['mac', 'windows', 'linux'].includes(platform)) throw new Error('Unsupported platform');
  if (platform === 'linux' && !arch) throw new Error('Linux architecture required');
  const base = remoteConsoleUrl();
  const groups = z.record(z.string().uuid(), meshNodeId).parse(JSON.parse(process.env.MESHCENTRAL_TENANT_GROUPS || '{}'));
  const linuxGroups = z.record(z.string().uuid(), meshNodeId).parse(JSON.parse(process.env.MESHCENTRAL_LINUX_TENANT_GROUPS || '{}'));
  const group = (platform === 'linux' ? linuxGroups[tenantId] : undefined) || groups[tenantId];
  if (!base || !group) return null;
  const url = new URL(platform === 'mac' ? '/meshosxagent' : '/meshagents', base);
  url.searchParams.set('id', platform === 'mac' ? '10005' : platform === 'linux' ? (arch === 'arm64' ? '26' : '6') : '4');
  url.searchParams.set('meshid', group);
  const settings = new URL('/meshsettings', base);
  settings.searchParams.set('id', group);
  return { settingsUrl: settings.toString(), url: url.toString(), server: base, group, platform };
}
