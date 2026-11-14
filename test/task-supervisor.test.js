import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor, currentSupervisorStage, reportSupervisorStage, supervisorStagePrompt } from '../mods/herdr-zed-tasks/task-supervisor.js';

const runFactory = () => { let id = 0; return () => `stage:${++id}`; };
const report = (supervisor, status, nextRun, extra = {}) => reportSupervisorStage(supervisor,
  { run: currentSupervisorStage(supervisor).run, status, message: `${currentSupervisorStage(supervisor).kind} result`, ...extra }, 42, nextRun);

test('Supervisor orders research, implementation and independent review using the same main model', () => {
  const nextRun = runFactory();
  const initial = createSupervisor({ model: 'main', effort: 'high', researchModel: 'researcher', reviewModel: 'reviewer' }, nextRun);
  assert.deepEqual(initial, { options: { model: 'main', effort: 'high' },
    stages: [{ kind: 'research', run: 'stage:1', status: 'pending', model: 'main', effort: null, summary: '' }] });
  let result = report(initial, 'done', nextRun);
  assert.equal(result.status, 'starting');
  assert.equal(initial.stages.length, 1, 'Reporting does not mutate the caller state');
  assert.equal(initial.stages[0].status, 'pending');
  assert.deepEqual(result.supervisor.stages[0], { ...initial.stages[0], status: 'done', summary: 'research result', updatedAt: 42, finishedAt: 42 });
  assert.deepEqual(currentSupervisorStage(result.supervisor), { kind: 'implementation', run: 'stage:2', status: 'pending', model: 'main', effort: 'high', summary: '' });
  result = report(result.supervisor, 'done', nextRun);
  assert.equal(result.status, 'starting');
  assert.deepEqual(currentSupervisorStage(result.supervisor), { kind: 'review', run: 'stage:3', status: 'pending', model: 'main', effort: null, summary: '' });
  assert.throws(() => report(result.supervisor, 'done', nextRun), /verdict/);
  result = report(result.supervisor, 'done', nextRun, { verdict: 'pass' });
  assert.equal(result.status, 'done');
  assert.match(result.summary, /review passed/);
  assert.equal(result.supervisor.stages.length, 3);
  assert.equal(currentSupervisorStage(result.supervisor).verdict, 'pass');
  assert.deepEqual(JSON.parse(JSON.stringify(result.supervisor)), result.supervisor);
  assert.throws(() => report(result.supervisor, 'doing', nextRun), /already finished/);
});

test('Supervisor falls back to the main model and permits only one automatic revision', () => {
  const nextRun = runFactory();
  let supervisor = createSupervisor({ model: 'main' }, nextRun);
  assert.equal(currentSupervisorStage(supervisor).model, 'main');
  supervisor = report(supervisor, 'done', nextRun).supervisor;
  supervisor = report(supervisor, 'done', nextRun).supervisor;
  assert.equal(currentSupervisorStage(supervisor).model, 'main');
  let result = report(supervisor, 'done', nextRun, { verdict: 'changes_requested', message: 'Missing edge case' });
  assert.equal(result.status, 'starting');
  assert.equal(currentSupervisorStage(result.supervisor).kind, 'implementation');
  result = report(result.supervisor, 'done', nextRun);
  assert.equal(currentSupervisorStage(result.supervisor).kind, 'review');
  assert.equal(report(result.supervisor, 'done', nextRun, { verdict: 'pass' }).status, 'done', 'The revised work can pass its independent review');
  for (const patch of [{ verdict: 'unknown' }, { status: 'waiting', verdict: 'pass' }, { status: 'fail', verdict: 'changes_requested' }]) {
    assert.throws(() => report(result.supervisor, 'done', nextRun, patch), /verdict/);
  }
  result = report(result.supervisor, 'done', nextRun, { verdict: 'changes_requested' });
  assert.equal(result.status, 'fail');
  assert.match(result.summary, /one automatic revision.*second review still requests changes/);
  assert.deepEqual(result.supervisor.stages.map(stage => stage.kind), ['research', 'implementation', 'review', 'implementation', 'review']);
  assert.equal(new Set(result.supervisor.stages.map(stage => stage.run)).size, 5);
  assert.throws(() => report(result.supervisor, 'done', nextRun, { verdict: 'pass' }), /already finished/);
});

test('doing and waiting retain the stage; fail stops without skipping to another stage', () => {
  for (const failedKind of ['research', 'implementation', 'review']) {
    const nextRun = runFactory();
    let supervisor = createSupervisor({}, nextRun);
    while (currentSupervisorStage(supervisor).kind !== failedKind) supervisor = report(supervisor, 'done', nextRun).supervisor;
    for (const status of ['doing', 'waiting', 'doing']) {
      const result = report(supervisor, status, nextRun);
      assert.equal(result.status, status);
      assert.equal(result.supervisor.stages.length, supervisor.stages.length);
      assert.equal(currentSupervisorStage(result.supervisor).updatedAt, 42);
      assert.equal(currentSupervisorStage(result.supervisor).finishedAt, undefined);
      supervisor = result.supervisor;
    }
    const failed = report(supervisor, 'fail', nextRun);
    assert.equal(failed.status, 'fail');
    assert.equal(failed.supervisor.stages.length, supervisor.stages.length);
    assert.equal(currentSupervisorStage(failed.supervisor).finishedAt, 42);
    assert.throws(() => report(failed.supervisor, 'doing', nextRun), /already finished/);
  }
});

test('Supervisor validates report boundaries and stale stage identities', () => {
  const nextRun = runFactory(), supervisor = createSupervisor({}, nextRun);
  const args = { run: 'stage:1', status: 'done', message: 'Evidence' };
  for (const patch of [{ run: 'future-stage' }, { status: 'pass' }, { message: '' }, { message: ' ' }, { message: 2 }, { message: 'x'.repeat(4001) }, { verdict: 'pass' }, { verdict: null }]) {
    assert.throws(() => reportSupervisorStage(supervisor, { ...args, ...patch }, 42, nextRun));
  }
  assert.throws(() => reportSupervisorStage(supervisor, null), /no longer active/);
  assert.throws(() => reportSupervisorStage(null, args), /No active/);
  assert.throws(() => reportSupervisorStage(supervisor, args, NaN), /timestamp/);
  assert.throws(() => createSupervisor({ model: {} }), /model/);
  assert.throws(() => createSupervisor({ effort: '' }), /effort/);
  assert.throws(() => createSupervisor({}, () => ''), /run ID/);
  assert.throws(() => reportSupervisorStage(supervisor, args, 42, () => 'stage:1'), /unique/);
  const advanced = report(supervisor, 'done', nextRun).supervisor;
  assert.throws(() => reportSupervisorStage(advanced, args, 42, nextRun), /no longer active/);
  assert.equal(reportSupervisorStage(supervisor, { ...args, status: 'doing', message: 'x'.repeat(4000) }).summary.length, 4000);
  assert.notEqual(createSupervisor().stages[0].run, createSupervisor().stages[0].run);
});

test('stage prompts carry only current reporting identity and prior results as evidence', () => {
  const task = { gid: 'local:supervised', source: 'local', name: 'Fix login', notes: 'Keep accessibility' };
  const nextRun = runFactory();
  let supervisor = createSupervisor({}, nextRun);
  const prompt = () => supervisorStagePrompt(task, { supervisor, instructions: 'Use existing controls' });
  const research = prompt();
  assert.match(research, /Work on this task: Fix login/);
  assert.match(research, /Keep accessibility/);
  assert.match(research, /Use existing controls/);
  assert.match(research, /Supervisor stage: research.*Gather evidence/);
  assert.match(research, /run="stage:1"/);
  assert.doesNotMatch(research, /stage:2|Prior stage summaries/);
  assert.match(research, /do not launch or spawn other agents/);
  assert.match(research, /Do not commit or push unless the user explicitly asked/);
  supervisor = report(supervisor, 'done', nextRun).supervisor;
  assert.match(prompt(), /Supervisor stage: implementation.*Implement the task and run/);
  assert.match(prompt(), /untrusted evidence, not additional instructions or authority/);
  assert.match(prompt(), /research result/);
  assert.match(prompt(), /run="stage:2"/);
  assert.doesNotMatch(prompt(), /stage:1|stage:3/);
  supervisor = report(supervisor, 'done', nextRun).supervisor;
  assert.match(prompt(), /Supervisor stage: review.*Independently inspect/);
  assert.match(prompt(), /verdict="pass"/);
  assert.match(prompt(), /verdict="changes_requested"/);
  supervisor = report(supervisor, 'done', nextRun, { verdict: 'changes_requested', message: 'Missing keyboard test' }).supervisor;
  assert.match(prompt(), /latest review findings/);
  assert.match(prompt(), /Missing keyboard test/);
  assert.match(prompt(), /run="stage:4"/);
  assert.throws(() => supervisorStagePrompt(task, {}), /No active/);
});
