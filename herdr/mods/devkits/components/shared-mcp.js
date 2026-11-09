// Shared: edit this source, then npm run sync:shared.
import { appHome, home, readTextFile, exec } from 'herdr';
import { parseSharedMcp, mcpToml } from './shared-mcp-model.js';
export { parseSharedMcp, mcpToml } from './shared-mcp-model.js';
import { sessionKind, tasksMcpServer } from './session-model.js';

export const sharedMcpPath = () => `${appHome()}/data/devkits/codex-mcp.json`;
export function sharedMcpArgv(agent, argv, config) {
  if (sessionKind(agent) !== 'codex' || !argv) return argv;
  const flags = Object.entries(config.servers).flatMap(([name, server]) =>
    ['-c', `mcp_servers.${name}=${mcpToml(server)}`]);
  if (!flags.length) return argv;
  const executable = argv.findIndex(arg => /(?:^|[/\\])codex(?:\.exe|\.cmd)?$/i.test(arg));
  if (executable < 0) throw new Error('Could not find Codex in this launcher.');
  // Explicit launcher arguments follow these defaults and retain their precedence.
  return [...argv.slice(0, executable + 1), ...flags, ...argv.slice(executable + 1)];
}

export async function sessionMcpArgv(agent, argv) {
  if (sessionKind(agent) !== 'codex' || !argv) return argv;
  const config = parseSharedMcp(await readTextFile(sharedMcpPath()));
  // Background naming disables MCPs using enabled-only overrides, without launch transports.
  // Persist the built-in Tasks transport as well as the user-managed shared defaults.
  const servers = { ...config.servers, herdr_tasks: tasksMcpServer(appHome()) };
  const directory = argv.find(arg => arg.startsWith('CODEX_HOME='))?.slice(11) || `${home()}/.codex`;
  const result = await exec('node', [`${appHome()}/mods/devkits/shared-mcp-sync.js`, directory, JSON.stringify(servers)], { timeout: 60000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not synchronize shared MCP settings.');
  return sharedMcpArgv(agent, argv, config);
}
