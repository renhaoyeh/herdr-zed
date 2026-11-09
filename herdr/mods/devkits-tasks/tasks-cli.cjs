const { bridge } = require('./mcp-server.cjs');
const manual = `Herdr Tasks progress reporting

Use the run ID supplied in your task prompt. It identifies the exact project and task attempt.
Never report for another run.
Run: node <this-file> report --run <id> --status <state> --message <text>
For an ordinary or existing conversation without a run ID, omit --run. HC_TERMINAL_ID binds the report to your own live Herdr task. Report doing to begin an attempt.

States:
  doing    Start work, resume after an answer, or describe meaningful progress.
  waiting  You need a user answer. State the exact question, then ask the user through your normal interface.
  done     The WHOLE task is finished. Include the result, validation and remaining limitations.
  fail     You cannot complete this attempt. Explain the reason and what was preserved.

Report doing before work. Report waiting before asking a question, and doing after receiving its answer.
Permission/login prompts are also detected by Herdr. Finishing a reply is not task completion.
Keep messages concise. Do not start other agents or hand off work unless the user authorized it.
If reporting fails, continue authorized work and include the reporting failure in your final response.
The live Devkits Tasks service must be available. Reports never edit shared.json directly.
`;
async function main(argv = process.argv.slice(2), call = bridge) {
  if (argv.length === 1 && ['--skill', '--help'].includes(argv[0])) return manual;
  if (argv[0] !== 'report' || argv.length % 2 !== 1) throw new Error('Use --skill for reporting instructions.');
  const fields = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['project', 'task', 'run', 'status', 'message'].includes(key) || !argv[i].startsWith('--') || key in fields)
      throw new Error('Unknown or repeated reporting option.');
    fields[key] = argv[i+1];
  }
  if (!fields.run) {
    if (!process.env.HC_TERMINAL_ID) throw new Error('Run this command inside the task’s HC terminal, or provide --run.');
    fields.terminal = process.env.HC_TERMINAL_ID;
  }
  return JSON.stringify(await call('report_task', fields));
}
module.exports = { main, manual };
if (require.main === module) main().then(text => process.stdout.write(text + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
