// Shared: edit this source, then npm run sync:shared.
import { appHome, readTextFile } from 'herdr';
import { sessionKind, settingsKey } from './session-model.js';

export const sharedMcpPath = () => `${appHome()}/data/devkits/codex-mcp.json`;
const mcpObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function mcpTable(value, overrides = false) {
  if (!mcpObject(value)) throw new Error('MCP servers must be a JSON object.');
  for (const [name, server] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('MCP server names must use letters, numbers, hyphens or underscores.');
    if (overrides && server === false) continue;
    if (!mcpObject(server) || (typeof server.command !== 'string' && typeof server.url !== 'string')) {
      throw new Error(`${name}: provide a command or a URL, or false to disable a profile server.`);
    }
    if (server.command !== undefined && server.url !== undefined) throw new Error(`${name}: choose command or URL.`);
    if (server.command !== undefined && !server.command.trim()) throw new Error(`${name}: command must not be empty.`);
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`${name}: args must be an array of strings.`);
    }
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') throw new Error(`${name}: enabled must be true or false.`);
    // Shared entries are local integrations. Account-authorized remote services stay in each account.
    if (server.url !== undefined && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(server.url)) {
      throw new Error(`${name}: shared MCP URLs must use localhost, 127.0.0.1 or [::1].`);
    }
    if (server.bearer_token || server.http_headers || server.env) {
      throw new Error(`${name}: keep literal credentials in the account configuration; use env_vars, env_http_headers or bearer_token_env_var here.`);
    }
    mcpToml(server); // Reject null and unsupported JSON values before saving or launching.
  }
  return value;
}

export function parseSharedMcp(text) {
  if (text === null || text === undefined) return { version: 1, servers: {}, profiles: {} };
  const value = JSON.parse(text);
  if (!mcpObject(value) || value.version !== 1 || !mcpObject(value.profiles || {})) throw new Error('Unsupported shared MCP file. Expected version 1.');
  mcpTable(value.servers);
  for (const overrides of Object.values(value.profiles || {})) mcpTable(overrides, true);
  return { ...value, profiles: value.profiles || {} };
}

// JSON strings are TOML basic strings; object keys must be quoted separately from values.
export function mcpToml(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(mcpToml).join(',')}]`;
  if (mcpObject(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${mcpToml(item)}`).join(',')}}`;
  throw new Error('MCP settings support strings, finite numbers, booleans, arrays and objects.');
}

export function sharedMcpArgv(agent, argv, config) {
  if (sessionKind(agent) !== 'codex' || !argv) return argv;
  // A named agent inherits its account's exceptions and can add its own exceptions.
  const overrides = { ...config.profiles[agent.profileKey || agent.key], ...config.profiles[settingsKey(agent)] };
  const servers = { ...config.servers, ...overrides };
  const flags = Object.entries(servers).flatMap(([name, server]) => server === false
    ? Object.hasOwn(config.servers, name)
      ? ['-c', `mcp_servers.${name}=${mcpToml({ ...config.servers[name], enabled: false })}`]
      : [] // A removed common server may still have an old profile exclusion.
    : ['-c', `mcp_servers.${name}=${mcpToml(server)}`]);
  if (!flags.length) return argv;
  const executable = argv.findIndex(arg => /(?:^|[/\\])codex(?:\.exe|\.cmd)?$/i.test(arg));
  if (executable < 0) throw new Error('Could not find Codex in this launcher.');
  // Explicit launcher arguments follow these defaults and retain their precedence.
  return [...argv.slice(0, executable + 1), ...flags, ...argv.slice(executable + 1)];
}

export async function sessionMcpArgv(agent, argv) {
  if (sessionKind(agent) !== 'codex' || !argv) return argv;
  return sharedMcpArgv(agent, argv, parseSharedMcp(await readTextFile(sharedMcpPath())));
}
