// Shared: edit this source, then npm run sync:shared.
import { appHome, home, readTextFile, exec, window } from 'herdr';
import { parseSharedMcp, mcpToml, platformSharedMcp, claudeMcpConfig } from './shared-mcp-model.js';
export { parseSharedMcp, mcpToml, claudeMcpConfig } from './shared-mcp-model.js';
import { sessionKind, tasksMcpServer } from './session-model.js';

export const sharedMcpPath = () => `${appHome()}/data/herdr-zed/shared-mcp.json`;
export function sharedMcpArgv(agent, argv, config) {
  const kind = sessionKind(agent);
  if (!['codex', 'claude'].includes(kind) || !argv) return argv;
  if (kind === 'claude') {
    // herdr_tasks has its own --mcp-config from sessionArgv.
    const { mcpServers } = claudeMcpConfig(Object.fromEntries(Object.entries(config.servers).filter(([name]) => name !== 'herdr_tasks')));
    if (!Object.keys(mcpServers).length) return argv;
    const executable = argv.findIndex(arg => /(?:^|[/\\])claude(?:\.exe|\.cmd)?$/i.test(arg));
    if (executable < 0) throw new Error('Could not find Claude Code in this launcher.');
    return [...argv.slice(0, executable + 1), '--mcp-config', JSON.stringify({ mcpServers }), ...argv.slice(executable + 1)];
  }
  const flags = Object.entries(config.servers).flatMap(([name, server]) =>
    ['-c', `mcp_servers.${name}=${mcpToml(server)}`]);
  if (!flags.length) return argv;
  const executable = argv.findIndex(arg => /(?:^|[/\\])codex(?:\.exe|\.cmd)?$/i.test(arg));
  if (executable < 0) throw new Error('Could not find Codex in this launcher.');
  // Explicit launcher arguments follow these defaults and retain their precedence.
  return [...argv.slice(0, executable + 1), ...flags, ...argv.slice(executable + 1)];
}

export async function sessionMcpArgv(agent, argv) {
  const kind = sessionKind(agent);
  if (!['codex', 'claude'].includes(kind) || !argv) return argv;
  const config = platformSharedMcp(parseSharedMcp(await readTextFile(sharedMcpPath())), window()?.platform);
  // Claude takes per-launch --mcp-config and never writes account files.
  if (kind === 'claude') return sharedMcpArgv(agent, argv, config);
  // Background naming disables MCPs using enabled-only overrides, without launch transports.
  // Persist the built-in Tasks transport as well as the user-managed shared defaults.
  const servers = { ...config.servers, herdr_tasks: tasksMcpServer(appHome()) };
  const directory = argv.find(arg => arg.startsWith('CODEX_HOME='))?.slice(11) || `${home()}/.codex`;
  const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/shared-mcp-sync.js`, directory, JSON.stringify(servers)], { timeout: 60000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not synchronize shared MCP settings.');
  return sharedMcpArgv(agent, argv, config);
}
