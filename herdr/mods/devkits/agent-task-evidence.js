import { shared, setShared, hc, exec, readTextFile, home, appHome } from 'herdr';
import { agentCommand } from './model.js';

const inputProbes = new Map();
const INPUT_EVIDENCE = 'devkits.task-input-evidence';
export const tracksTaskInput = agent => !String(agent.address || '').includes('/') && ['codex', 'claude-code', 'claude'].includes(agent.app);

// A core turn also counts agent initialization. Check for an actual user-message
// event in the local conversation instead of treating startup as a completed task.
async function locateTaskFile(agent, services) {
  const reply = await services.hc(['get', agent.address, '--json']);
  if (reply.code) return null;
  const terminal = JSON.parse(reply.stdout);
  const pid = terminal.foreground?.pid;
  if (!Number.isInteger(pid)) return null;
  const command = agentCommand(terminal.argv) || terminal.foreground?.argv || [];
  let file;
  if (agent.app === 'codex') {
    const result = await services.exec('sh', ['-c', 'pids=$(pgrep -P "$1" | tr "\\n" ,)$1; lsof -Fn -p "$pids"', 'sh', String(pid)]);
    file = (result.stdout || '').split('\n').filter(line => /^n.*\/rollout-[^/]+\.jsonl$/.test(line)).sort()[0]?.slice(1);
  } else {
    const dir = command.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice(18) || `${services.home()}/.claude`;
    const id = JSON.parse(await services.readTextFile(`${dir}/sessions/${pid}.json`) || '{}').sessionId;
    if (id) {
      const result = await services.exec('sh', ['-c', 'printf "%s\\n" "$1"/projects/*/"$2".jsonl', 'sh', dir, id]);
      file = result.stdout?.split('\n').find(path => path && !path.includes('*'));
    }
  }
  if (!file) return null;
  return file || null;
}

export async function probeTaskState(agent, previous = {}, services = { hc, exec, readTextFile, home, appHome }) {
  const file = previous.file || await locateTaskFile(agent, services);
  if (!file) return { hasInput: null, needsInput: false };
  const result = await services.exec('node', [`${services.appHome()}/mods/devkits/agent-task-events.cjs`, file,
    agent.app === 'codex' ? 'codex' : 'claude', JSON.stringify(previous.file === file ? previous.cursor || {} : {})]);
  if (result.code) return { hasInput: previous.hasInput ?? null, needsInput: Boolean(previous.needsInput), file, cursor: previous.cursor };
  return { ...JSON.parse(result.stdout), file };
}

export function observeTaskInput(agents, terminals, cx) {
  if (!cx?.spawn) return;
  const previous = shared(INPUT_EVIDENCE) || {};
  const tracked = agents.filter(tracksTaskInput);
  const addresses = new Set(tracked.map(agent => agent.address));
  const all = Object.fromEntries(Object.entries(previous).filter(([address]) => addresses.has(address)));
  if (Object.keys(all).length !== Object.keys(previous).length) setShared(INPUT_EVIDENCE, all);
  for (const address of inputProbes.keys()) if (!addresses.has(address)) inputProbes.delete(address);
  for (const agent of tracked) {
    const current = all[agent.address];
    const terminal = terminals.find(terminal => terminal.address === agent.address);
    const identity = `${agent.app}:${terminal?.foreground?.pid || terminal?.created_ms || terminal?.pid || ''}`;
    if (inputProbes.get(agent.address)?.identity === identity) continue;
    if (current?.identity === identity && current.seq === agent.seq && current.hasInput === true
      && !current.needsInput && agent.status !== 'working') continue;
    if (current?.identity === identity && current.seq === agent.seq
      && ((agent.status !== 'working' && !current.needsInput) || Date.now() - current.at < 1400)) continue;
    const probe = { identity };
    inputProbes.set(agent.address, probe);
    cx.spawn(async cx => {
      try {
        let evidence = { hasInput: current?.identity === identity ? current.hasInput : null, needsInput: current?.identity === identity && Boolean(current.needsInput) };
        try { evidence = await probeTaskState(agent, current?.identity === identity ? current : {}); } catch {}
        if (inputProbes.get(agent.address) !== probe) return;
        setShared(INPUT_EVIDENCE, { ...(shared(INPUT_EVIDENCE) || {}), [agent.address]: {
          ...evidence, identity, seq: agent.seq, at: Date.now() } });
      } finally { if (inputProbes.get(agent.address) === probe) inputProbes.delete(agent.address); cx.notify(); }
    });
  }
}

export function withTaskInputEvidence(agents, terminals = []) {
  const all = shared(INPUT_EVIDENCE) || {};
  return agents.map(agent => {
    if (!tracksTaskInput(agent)) return agent;
    const terminal = terminals.find(terminal => terminal.address === agent.address);
    const identity = `${agent.app}:${terminal?.foreground?.pid || terminal?.created_ms || terminal?.pid || ''}`;
    const evidence = all[agent.address];
    return { ...agent, inputTracked: true, hasInput: evidence?.identity === identity && evidence.hasInput === true,
      needsInput: evidence?.identity === identity && evidence.needsInput === true };
  });
}
