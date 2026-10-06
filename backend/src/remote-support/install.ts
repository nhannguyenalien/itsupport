import { z } from 'zod';
import { meshNodeId, remoteConsoleUrl } from './links.js';

const groupMap = z.record(z.string().uuid(), meshNodeId);

// MeshCentral group ids contain `$` and `@`. Docker Compose, Coolify and shells
// all treat `$` specially, so the ids can be passed base64-encoded in
// <NAME>_B64 (preferred, immune to that) or as plain JSON in <NAME>.
function readGroups(name: string): Record<string, string> {
  const encoded = process.env[name + '_B64'];
  const raw = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : (process.env[name] || '{}');
  try {
    return groupMap.parse(JSON.parse(raw));
  } catch (error) {
    // A broken value is a deployment problem, not a bad request. Say which
    // variable and what is wrong with its shape, never what it contains.
    let values: unknown[] = [];
    try { values = Object.values(JSON.parse(raw)); } catch { /* not JSON at all */ }
    console.error(JSON.stringify({
      level: 50, msg: 'remote support configuration invalid', variable: name, source: encoded ? 'base64' : 'plain',
      reason: error instanceof SyntaxError ? 'not valid JSON' : 'group id does not match the MeshCentral id format',
      idLengths: values.map(v => (typeof v === 'string' ? v.length : -1)),
      containsDoubleDollar: raw.includes('$$'),
    }));
    throw Object.assign(new Error('Remote support is misconfigured'), { statusCode: 503 });
  }
}

// Explicit tenant assignments prevent enrollment into another customer's group.
export function remoteInstall(tenantId: string, platform: string, arch?: 'amd64' | 'arm64') {
  if (!['mac', 'windows', 'linux'].includes(platform)) throw new Error('Unsupported platform');
  if (platform === 'linux' && !arch) throw new Error('Linux architecture required');
  const base = remoteConsoleUrl();
  const groups = readGroups('MESHCENTRAL_TENANT_GROUPS');
  const linuxGroups = readGroups('MESHCENTRAL_LINUX_TENANT_GROUPS');
  const group = (platform === 'linux' ? linuxGroups[tenantId] : undefined) || groups[tenantId];
  if (!base || !group) return null;
  const url = new URL(platform === 'mac' ? '/meshosxagent' : '/meshagents', base);
  url.searchParams.set('id', platform === 'mac' ? '10005' : platform === 'linux' ? (arch === 'arm64' ? '26' : '6') : '4');
  url.searchParams.set('meshid', group);
  const settings = new URL('/meshsettings', base);
  settings.searchParams.set('id', group);
  return { settingsUrl: settings.toString(), url: url.toString(), server: base, group, platform };
}
