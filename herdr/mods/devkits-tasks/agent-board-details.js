import { hc } from 'herdr';

// Read only the attached agents. Never type into a terminal to obtain task details.
export async function readTaskOutput(task, request = hc) {
  const agents = [...new Map(task.agents.map(agent => [agent.address, agent])).values()];
  const outputs = await Promise.all(agents.map(async agent => {
    const result = await request(['read', agent.address, '--lines', '80', '--json']);
    if (result.code) throw new Error(result.stderr?.trim() || 'Could not read agent output.');
    const payload = JSON.parse(result.stdout || '{}');
    const text = (payload.text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    return agents.length > 1 ? `${agent.program?.name || 'Agent'} · ${agent.address}\n\n${text}` : text;
  }));
  return outputs.join('\n\n────────\n\n').slice(-12000);
}

export const taskIdentifier = task => task.mantisbt ? 'MANTISBT' : task.asana ? 'ASANA' : task.source === 'thread' ? 'THREAD' : task.source === 'local' ? 'LOCAL' : 'ASANA';
export function outputMarkdown(text) {
  const fence = '`'.repeat(Math.max(3, ...((text || '').match(/`+/g) || []).map(run => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
