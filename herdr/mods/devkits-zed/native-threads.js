import { spaces, shared, setShared, run, closeOverlay, window } from 'herdr';
import { terminalArgv } from './components/session-shell.js';

// Use the program Herdr knows, unchanged. No account preparation, policies or MCP injection.
export function createNativeThread(agent, target, api = { spaces, shared, setShared, run, closeOverlay, window }) {
  const project = api.spaces().find(space => space.id === target.space);
  const machine = project?.machine || target.machine || null;
  let argv = agent?.run;
  if (agent && (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string')))
    throw new Error('This program has no launch command.');
  if (argv && !machine) argv = terminalArgv(argv, api.window()?.platform);
  const key = JSON.stringify([machine || '', (target.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || target.space]);
  api.setShared('devkits.conversation-visible', { ...(api.shared('devkits.conversation-visible') || {}), [key]: true });
  api.setShared('devkits.selected-project', null);
  api.run('layout.select', { stack: 'workspace-view', child: 'main' });
  if (target.space) api.run('tab.new', { space: target.space, folder: target.folder, ...(argv ? { name: agent.name, argv } : {}) });
  else api.run('space.new', { name: target.projectName, folder: target.folder, machine: machine || '', ...(argv ? { tab: agent.name, argv } : {}) });
  if (target.overlay) api.closeOverlay(target.overlay);
}
