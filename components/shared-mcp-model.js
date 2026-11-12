// Shared: edit this source, then npm run sync:shared.
const mcpObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function mcpTable(value) {
  if (!mcpObject(value)) throw new Error('MCP servers must be a JSON object.');
  for (const [name, server] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('MCP server names must use letters, numbers, hyphens or underscores.');
    if (!mcpObject(server) || (typeof server.command !== 'string' && typeof server.url !== 'string')) {
      throw new Error(`${name}: provide a command or a URL; use enabled=false to disable a shared server.`);
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
  if (text === null || text === undefined) return { version: 1, servers: {} };
  const value = JSON.parse(text);
  if (!mcpObject(value) || value.version !== 1) throw new Error('Unsupported shared MCP file. Expected version 1.');
  mcpTable(value.servers);
  if (Object.keys(value).some(key => !['version', 'servers'].includes(key)))
    throw new Error('Unsupported shared MCP fields. Expected only version and servers.');
  return { version: 1, servers: value.servers };
}

// JSON strings are TOML basic strings; object keys must be quoted separately from values.
export function mcpToml(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(mcpToml).join(',')}]`;
  if (mcpObject(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${mcpToml(item)}`).join(',')}}`;
  throw new Error('MCP settings support strings, finite numbers, booleans, arrays and objects.');
}

// Known built-in integrations retain their configuration on unsupported hosts.
export const sharedMcpPlatforms = { visual_studio: ['windows'] };
export const sharedMcpSupported = (name, platform) => !sharedMcpPlatforms[name] || sharedMcpPlatforms[name].includes(platform);
export const platformSharedMcp = (config, platform) => ({ ...config,
  servers: Object.fromEntries(Object.entries(config.servers).filter(([name]) => sharedMcpSupported(name, platform))) });

// Claude reads mcpServers JSON. Its stdio servers inherit the launch environment, so env_vars needs no forwarding;
// header variables use Claude's ${VAR} expansion. Codex-only tuning fields have no Claude equivalent and are omitted.
export function claudeMcpServer(server) {
  if (server.url !== undefined) {
    const headers = { ...Object.fromEntries(Object.entries(server.env_http_headers || {}).map(([header, name]) => [header, `\${${name}}`])),
      ...(server.bearer_token_env_var ? { Authorization: `Bearer \${${server.bearer_token_env_var}}` } : {}) };
    return { type: 'http', url: server.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  return { type: 'stdio', command: server.command, ...(server.args ? { args: server.args } : {}) };
}

export const claudeMcpConfig = servers => ({ mcpServers: Object.fromEntries(Object.entries(servers)
  .filter(([, server]) => server.enabled !== false).map(([name, server]) => [name, claudeMcpServer(server)])) });
