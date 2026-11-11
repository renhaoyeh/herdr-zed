import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtensionManifest, extensionMetadata, extensionPopup, resolveProviders, launcherAvailable } from '../mods/herdr-zed/extension-model.js';
import { validateLaunchRequest, validateLaunchTarget, validateDecorations, gitCredentialArgs, projectKey, newTerminalCommand, readNewTerminalCommand } from '../components/extension-contract.js';

const action = (overrides = {}) => ({ id: 'open', title: 'Open', icon: 'globe', location: 'status.right',
  popup: { view: 'details', width: 1000, height: 700, modal: false }, ...overrides });
const base = (overrides = {}) => ({ version: 1, id: 'tasks', title: 'Tasks', actions: [], ...overrides });
const parse = (value, mod = 'herdr-zed-tasks') => parseExtensionManifest(mod, JSON.stringify(value));
const rejects = (value, mod) => assert.throws(() => parse(value, mod));

const launcher = { picker: { view: 'launcher', width: 280 } };
const provides = patch => ({ launcher, ...patch });

// ---- manifest: actions, requires, provides ----

test('actions accept status.right and git.actions and reject other locations', () => {
  const [status] = parse(base({ actions: [action()] }));
  assert.equal(status.location, 'status.right');
  const [git] = parse(base({ actions: [action({ location: 'git.actions' })] }));
  assert.equal(git.location, 'git.actions');
  for (const location of ['dock.right', 'sidebar.bottom', 'git', '']) rejects(base({ actions: [action({ location })] }));
});

test('requires accepts unique extension IDs and rejects self, duplicates, bad IDs and oversize lists', () => {
  assert.deepEqual(extensionMetadata('herdr-zed-calendar', JSON.stringify(base({ id: 'calendar', requires: ['tasks'] }))).requires, ['tasks']);
  rejects(base({ requires: 'tasks' }));
  rejects(base({ requires: ['tasks'] }), 'herdr-zed-tasks'); // self-reference (id is tasks)
  rejects(base({ requires: null }));
  rejects(base({ requires: ['tasks', 'tasks'] }));
  rejects(base({ requires: ['Tasks'] }));
  rejects(base({ requires: ['../escape'] }));
  rejects(base({ requires: Array.from({ length: 17 }, (_, index) => `ext-${index}`) }));
  parse(base({ requires: Array.from({ length: 16 }, (_, index) => `ext-${index}`) }));
});

test('provides accepts each declared provider contract', () => {
  parse(base({ provides: provides({
    threadDecorator: { fields: ['badge', 'subtitle', 'tone'] },
    importer: { accepts: ['task-snapshot'], view: 'import-draft' },
    gitCredentials: {},
  }) }));
  parse(base({ provides: {} }));
});

test('provides rejects unknown provider keys and non-object provides', () => {
  rejects(base({ provides: { ...provides(), dock: {} } }));
  for (const value of [null, [], 'launcher', true]) rejects(base({ provides: value }));
});

test('launcher provides exactly picker {view,width}; a launcher settings key is rejected (settings live in the manifest)', () => {
  rejects(base({ provides: { launcher: {} } }));
  rejects(base({ provides: { launcher: { settings: { view: 'settings', width: 1040, height: 0.86 } } } }));
  rejects(base({ provides: { launcher: { ...launcher, settings: { view: 'settings', width: 1040, height: 0.86 } } } }));
  rejects(base({ provides: { launcher: { ...launcher, extra: true } } }));
  rejects(base({ provides: { launcher: { ...launcher, picker: { ...launcher.picker, height: 1 } } } }));
  rejects(base({ provides: { launcher: { ...launcher, picker: { view: 'Launcher', width: 280 } } } }));
  rejects(base({ provides: { launcher: null } }));
});

test('launcher dimensions accept fractions and pixels up to 2400 and reject others', () => {
  for (const width of [0.5, 1, 280, 2400]) parse(base({ provides: { launcher: { ...launcher, picker: { view: 'launcher', width } } } }));
  for (const width of [0, -1, 2401, Number.NaN, '280', Infinity])
    rejects(base({ provides: { launcher: { ...launcher, picker: { view: 'launcher', width } } } }));
});

test('threadDecorator requires a non-empty unique subset of badge, subtitle, tone', () => {
  parse(base({ provides: { threadDecorator: { fields: ['tone'] } } }));
  for (const fields of [[], ['badge', 'badge'], ['badge', 'color'], 'badge', ['badge', 'subtitle', 'tone', 'tone']])
    rejects(base({ provides: { threadDecorator: { fields } } }));
  rejects(base({ provides: { threadDecorator: { fields: ['badge'], view: 'x' } } }));
  rejects(base({ provides: { threadDecorator: {} } }));
});

test('importer requires accepts of task-snapshot only and a view name', () => {
  parse(base({ provides: { importer: { accepts: ['task-snapshot'], view: 'import-draft' } } }));
  for (const importer of [
    { accepts: [], view: 'import-draft' }, { accepts: ['task-snapshot', 'task-snapshot'], view: 'import-draft' },
    { accepts: ['calendar-event'], view: 'import-draft' }, { accepts: ['task-snapshot'] }, { accepts: ['task-snapshot'], view: '../x' },
    { accepts: ['task-snapshot'], view: 'import-draft', extra: 1 }])
    rejects(base({ provides: { importer } }));
});

test('gitCredentials provider must be an empty object', () => {
  parse(base({ provides: { gitCredentials: {} } }), 'herdr-zed-github');
  rejects(base({ provides: { gitCredentials: { helper: 'x' } } }), 'herdr-zed-github');
  rejects(base({ provides: { gitCredentials: [] } }), 'herdr-zed-github');
});

test('extensionMetadata returns id, requires and provides', () => {
  const text = JSON.stringify(base({ id: 'calendar', requires: ['tasks'], provides: { gitCredentials: {} } }));
  const metadata = extensionMetadata('herdr-zed-calendar', text);
  assert.equal(metadata.id, 'calendar');
  assert.deepEqual(metadata.requires, ['tasks']);
  assert.deepEqual(metadata.provides, { gitCredentials: {} });
  const bare = extensionMetadata('herdr-zed-tasks', JSON.stringify(base()));
  assert.deepEqual([bare.requires, bare.provides], [[], {}]);
});

test('popup stateKey uses the herdr-zed prefix', () => {
  const [entry] = parse(base({ actions: [action()] }));
  assert.equal(extensionPopup(entry, { id: 'p', folder: '/w', name: 'W' }).props.stateKey, 'herdr-zed.extension.tasks.["","/w"]');
});

// ---- resolveProviders ----

const pkg = (mod, id, extra = {}) => ({ mod, id, requires: [], provides: {}, ...extra });
const launcherPkg = (mod, id) => pkg(mod, id, { provides: { launcher } });
const gitPkg = (mod, id) => pkg(mod, id, { provides: { gitCredentials: {} } });

test('resolveProviders picks one launcher and one git credentials provider', () => {
  const result = resolveProviders([launcherPkg('herdr-zed-agents', 'agents'), gitPkg('herdr-zed-github', 'github'), pkg('herdr-zed-system', 'system')]);
  assert.deepEqual(result.launcher, { mod: 'herdr-zed-agents', id: 'agents', ...launcher });
  assert.deepEqual(result.gitCredentials, { mod: 'herdr-zed-github', id: 'github' });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unavailable, []);
});

test('two enabled launchers disable both and report one conflict naming both', () => {
  const result = resolveProviders([launcherPkg('herdr-zed-agents', 'agents'), launcherPkg('herdr-zed-other', 'other')]);
  assert.equal(result.launcher, null);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].provider, 'launcher');
  assert.deepEqual(result.conflicts[0].mods, ['herdr-zed-agents', 'herdr-zed-other']);
  assert.deepEqual(result.conflicts[0].ids, ['agents', 'other']);
});

test('two enabled gitCredentials providers disable both and report one conflict', () => {
  const result = resolveProviders([gitPkg('herdr-zed-github', 'github'), gitPkg('herdr-zed-gitlab', 'gitlab')]);
  assert.equal(result.gitCredentials, null);
  assert.deepEqual(result.conflicts, [{ provider: 'gitCredentials', mods: ['herdr-zed-github', 'herdr-zed-gitlab'], ids: ['github', 'gitlab'] }]);
});

test('disabling one of two launchers restores the other; disabled or errored packages do not conflict', () => {
  const packages = [launcherPkg('herdr-zed-agents', 'agents'), launcherPkg('herdr-zed-other', 'other'),
    pkg('herdr-zed-broken', 'broken', { error: 'bad manifest', provides: { gitCredentials: {} } })];
  const result = resolveProviders(packages, ['herdr-zed-other']);
  assert.equal(result.launcher.mod, 'herdr-zed-agents');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.gitCredentials, null);
  assert.deepEqual(result.unavailable, []);
});

test('a package whose required extension is missing, errored or disabled is unavailable and contributes nothing', () => {
  const calendar = pkg('herdr-zed-calendar', 'calendar', { requires: ['tasks'], provides: { threadDecorator: { fields: ['badge'] } } });
  const missing = resolveProviders([calendar]);
  assert.deepEqual(missing.unavailable, [{ mod: 'herdr-zed-calendar', id: 'calendar', missing: ['tasks'] }]);
  assert.deepEqual(missing.decorators, []);

  const errored = resolveProviders([pkg('herdr-zed-tasks', 'tasks', { error: 'x' }), calendar]);
  assert.deepEqual(errored.unavailable.map(entry => entry.id), ['calendar']);
  assert.deepEqual(errored.decorators, []);

  const disabled = resolveProviders([pkg('herdr-zed-tasks', 'tasks', { provides: { importer: { accepts: ['task-snapshot'], view: 'import-draft' } } }), calendar], ['herdr-zed-tasks']);
  assert.deepEqual(disabled.unavailable.map(entry => entry.id), ['calendar']);
  assert.deepEqual(disabled.importers, []);

  const enabled = resolveProviders([pkg('herdr-zed-tasks', 'tasks'), calendar]);
  assert.deepEqual(enabled.unavailable, []);
  assert.deepEqual(enabled.decorators, [{ mod: 'herdr-zed-calendar', id: 'calendar', fields: ['badge'] }]);
});

test('unavailability propagates through requires chains', () => {
  const chain = [pkg('herdr-zed-a', 'a', { requires: ['b'], provides: { gitCredentials: {} } }),
    pkg('herdr-zed-b', 'b', { requires: ['c'] })];
  const result = resolveProviders(chain);
  assert.deepEqual(result.unavailable.map(entry => entry.id).sort(), ['a', 'b']);
  assert.equal(result.gitCredentials, null);
});

test('resolveProviders collects importers and decorators from enabled packages', () => {
  const result = resolveProviders([
    pkg('herdr-zed-tasks', 'tasks', { provides: { importer: { accepts: ['task-snapshot'], view: 'import-draft' }, threadDecorator: { fields: ['badge', 'tone'] } } }),
    pkg('herdr-zed-asana', 'asana', { provides: {} }),
  ]);
  assert.deepEqual(result.importers, [{ mod: 'herdr-zed-tasks', id: 'tasks', accepts: ['task-snapshot'], view: 'import-draft' }]);
  assert.deepEqual(result.decorators, [{ mod: 'herdr-zed-tasks', id: 'tasks', fields: ['badge', 'tone'] }]);
});

// ---- launch requests (§3.1) ----

const NOW = 1_000_000;
const spaces = [{ id: 'local-space', machine: null }, { id: 'remote-space', machine: 'remote' }];
const request = (overrides = {}) => ({ id: 'req-1', source: 'agents', target: { space: 'local-space', folder: '/work/app', projectName: 'App' },
  name: 'Claude', argv: ['claude', '--resume', 'a b', ''], profile: 'work', expiresAt: NOW + 30_000, ...overrides });
const check = (value, options = {}) => validateLaunchRequest(value, { now: NOW, launcherId: 'agents', spaces, ...options });

test('a valid launch request is accepted and argv is returned as the same array', () => {
  const value = request();
  const result = check(value);
  assert.equal(result.ok, true);
  assert.equal(result.value.argv, value.argv, 'argv identity is preserved');
  assert.deepEqual(result.value.argv, ['claude', '--resume', 'a b', '']);
  assert.equal(result.value.profile, 'work');
  assert.equal(check(request({ profile: null, target: { folder: '/w' } })).ok, true);
  assert.equal(check(request({ target: { folder: '/w', machine: 'remote', space: 'remote-space' } })).ok, true);
});

test('launch request rejects expired and too-far-future expiresAt', () => {
  assert.equal(check(request({ expiresAt: NOW })).ok, false, 'expiresAt equal to now is expired');
  assert.equal(check(request({ expiresAt: NOW - 1 })).ok, false);
  assert.equal(check(request({ expiresAt: NOW + 60_000 })).ok, true, 'exactly now + 60 s is allowed');
  assert.equal(check(request({ expiresAt: NOW + 60_001 })).ok, false);
  assert.equal(check(request({ expiresAt: String(NOW + 1000) })).ok, false);
});

test('launch request rejects wrong source, inactive launcher and missing id', () => {
  assert.equal(check(request({ source: 'other' })).ok, false);
  assert.equal(check(request(), { launcherId: null }).ok, false);
  assert.equal(check(request({ id: '' })).ok, false);
  assert.equal(check(request({ id: undefined })).ok, false);
});

test('launch request rejects unknown spaces and machine mismatches', () => {
  assert.equal(check(request({ target: { space: 'missing', folder: '/w' } })).ok, false);
  assert.equal(check(request({ target: { space: 'remote-space', folder: '/w' } })).ok, false, 'remote space needs its machine');
  assert.equal(check(request({ target: { space: 'remote-space', folder: '/w', machine: 'other' } })).ok, false);
  assert.equal(check(request({ target: { space: 'local-space', folder: '/w', machine: 'remote' } })).ok, false);
});

test('launch request validates target fields, name, argv and profile', () => {
  assert.equal(check(request({ target: { folder: '' } })).ok, false);
  assert.equal(check(request({ target: { folder: '/w', extra: 1 } })).ok, false);
  assert.equal(check(request({ target: { folder: '/w', projectName: 3 } })).ok, false);
  assert.equal(check(request({ target: { folder: '/w', overlay: 3 } })).ok, false);
  assert.equal(check(request({ target: null })).ok, false);
  assert.equal(check(request({ name: '   ' })).ok, false);
  assert.equal(check(request({ name: 'x'.repeat(121) })).ok, false);
  assert.equal(check(request({ name: 'x'.repeat(120) })).ok, true);
  assert.equal(check(request({ argv: [] })).ok, false);
  assert.equal(check(request({ argv: ['claude', 1] })).ok, false);
  assert.equal(check(request({ argv: 'claude' })).ok, false);
  assert.equal(check(request({ profile: undefined })).ok, false);
  assert.equal(check(request({ profile: 3 })).ok, false);
  assert.equal(check(null).ok, false);
});

// ---- decorations (§3.3) ----

test('validateDecorations keeps valid entries and drops invalid ones per entry', () => {
  const result = validateDecorations({ updatedAt: 1, threads: {
    7: { badge: 'Work', subtitle: 'Profile', tone: 'warning' },
    8: { tone: 'accent' },
    9: { badge: 'x'.repeat(41) },
    10: { tone: 'purple' },
    11: { badge: 'ok', extra: 'field' },
    12: 'not an object',
    13: { subtitle: 'y'.repeat(40) },
    14: { badge: 4 },
  } });
  assert.deepEqual(result, { 7: { badge: 'Work', subtitle: 'Profile', tone: 'warning' }, 8: { tone: 'accent' }, 13: { subtitle: 'y'.repeat(40) } });
});

test('validateDecorations returns an empty map for malformed envelopes and accepts every tone', () => {
  assert.deepEqual(validateDecorations(null), {});
  assert.deepEqual(validateDecorations({ threads: [] }), {});
  assert.deepEqual(validateDecorations({ threads: null }), {});
  const threads = Object.fromEntries(['muted', 'accent', 'warning', 'error'].map((tone, index) => [index, { tone }]));
  assert.deepEqual(Object.keys(validateDecorations({ threads })), ['0', '1', '2', '3']);
});

// ---- git credentials (§3.5) ----

const binding = (overrides = {}) => ({ host: 'github.com', login: 'octo-cat', config: [
  ['credential.https://github.com.helper', ''],
  ['credential.https://github.com.helper', '!gh auth token --hostname github.com --user octo-cat'],
  ['credential.https://github.com.username', 'octo-cat'],
  ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
], ...overrides });

test('gitCredentialArgs applies valid pairs as -c key=value in order', () => {
  assert.deepEqual(gitCredentialArgs(binding()), [
    '-c', 'credential.https://github.com.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth token --hostname github.com --user octo-cat',
    '-c', 'credential.https://github.com.username=octo-cat',
    '-c', 'url.https://github.com/.insteadOf=git@github.com:',
    '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/',
  ]);
  assert.deepEqual(gitCredentialArgs(binding({ config: [] })), []);
  assert.deepEqual(gitCredentialArgs(binding({ host: 'ghe.example-corp.io', login: 'a_b.c', config: [] })), []);
});

test('gitCredentialArgs rejects bad host and login patterns', () => {
  for (const host of ['', '-github.com', 'github.com-', 'git hub.com', 'github.com/evil', 'a@b', 'github.com:443'])
    assert.throws(() => gitCredentialArgs(binding({ host, config: [] })), Error, host);
  for (const login of ['', '-octo', 'octo cat', 'octo;rm', '.x', 'a/b'])
    assert.throws(() => gitCredentialArgs(binding({ login, config: [] })), Error, login);
});

test('gitCredentialArgs rejects foreign keys, other hosts and extra keys', () => {
  const bad = [
    ['credential.https://gitlab.com.helper', 'x'],
    ['credential.https://github.com.password', 'x'],
    ['credential.helper', 'x'],
    ['credential.https://github.com.helper.extra', 'x'],
    ['url.https://gitlab.com/.insteadOf', 'git@gitlab.com:'],
    ['core.sshCommand', 'evil'],
    ['credential.https://github.com.helper\n', ''],
    ['url.https://github.com/.insteadOf ', 'git@github.com:'],
  ];
  for (const pair of bad) assert.throws(() => gitCredentialArgs(binding({ config: [pair] })), Error, pair[0]);
  assert.throws(() => gitCredentialArgs(binding({ config: [['credential.https://github.com.helper', 'x', 'extra']] })));
  assert.throws(() => gitCredentialArgs(binding({ config: ['credential.https://github.com.helper=x'] })));
});

test('gitCredentialArgs rejects values with NUL or newlines and non-string values', () => {
  for (const value of ['a\0b', 'a\nb', 'a\rb', 'end\n'])
    assert.throws(() => gitCredentialArgs(binding({ config: [['credential.https://github.com.username', value]] })), Error, JSON.stringify(value));
  assert.throws(() => gitCredentialArgs(binding({ config: [['credential.https://github.com.username', 3]] })));
});

test('gitCredentialArgs rejects bad insteadOf values', () => {
  for (const value of ['https://github.com/', 'git@gitlab.com:', 'git@github.com', 'ssh://git@github.com', 'git@github.com:evil', 'ssh://git@github.com/x'])
    assert.throws(() => gitCredentialArgs(binding({ config: [['url.https://github.com/.insteadOf', value]] })), Error, value);
});

test('gitCredentialArgs allows at most 8 pairs and rejects malformed config and bindings', () => {
  const pair = ['credential.https://github.com.username', 'octo-cat'];
  assert.equal(gitCredentialArgs(binding({ config: Array(8).fill(pair) })).length, 16);
  assert.throws(() => gitCredentialArgs(binding({ config: Array(9).fill(pair) })));
  assert.throws(() => gitCredentialArgs(binding({ config: undefined })));
  assert.throws(() => gitCredentialArgs(binding({ config: [['credential.https://github.com.username']] })));
  assert.throws(() => gitCredentialArgs(null));
  assert.throws(() => gitCredentialArgs(['github.com']));
});

// ---- projectKey (§3.5) ----

test('projectKey matches the shell project scope encoding', () => {
  assert.equal(projectKey('remote', '/workspace'), '["remote","/workspace"]');
  assert.equal(projectKey(null, '/workspace'), '["","/workspace"]');
  assert.equal(projectKey(undefined, '/w'), JSON.stringify(['', '/w']));
});

// ---- real manifests ----

// ---- launch target and Terminal command (§3.1) ----

test('validateLaunchTarget accepts a pending project (space null) and rejects unknown keys and bad fields', () => {
  assert.equal(validateLaunchTarget({ space: null, folder: '/w', projectName: 'W', machine: null }, spaces).ok, true);
  assert.equal(validateLaunchTarget({ folder: '/w', overlay: 'picker' }, spaces).ok, true);
  assert.equal(validateLaunchTarget({ space: 'local-space', folder: '/w' }, spaces).ok, true);
  assert.equal(validateLaunchTarget({ space: 'missing', folder: '/w' }, spaces).ok, false);
  assert.equal(validateLaunchTarget({ folder: '/w', view: 'launcher' }, spaces).ok, false, 'picker props other than the target are not a target');
  assert.equal(validateLaunchTarget({ folder: 4 }, spaces).ok, false);
  assert.equal(validateLaunchTarget('/w', spaces).ok, false);
  assert.equal(check(request({ target: { space: null, folder: '/w' } })).ok, true, 'a launch request accepts the same shape');
});

test('newTerminalCommand carries only the target fields of a picker, and readNewTerminalCommand validates them', () => {
  const picker = { view: 'launcher', overlay: 'picker-1', space: 'remote-space', folder: '/a b/%c', projectName: 'App', machine: 'remote', page: 'x' };
  const command = newTerminalCommand(picker);
  assert.match(command, /^new-terminal:/);
  const read = readNewTerminalCommand(command, spaces);
  assert.deepEqual(read, { ok: true, value: { space: 'remote-space', folder: '/a b/%c', projectName: 'App', machine: 'remote', overlay: 'picker-1' } });
  assert.deepEqual(readNewTerminalCommand(newTerminalCommand({ folder: '/w', space: null }), spaces).value, { space: null, folder: '/w' });
  assert.equal(readNewTerminalCommand('new-thread', spaces), null, 'other commands are not Terminal requests');
  assert.equal(readNewTerminalCommand('extension:open', spaces), null);
  assert.equal(readNewTerminalCommand('new-terminal:%7B', spaces).ok, false, 'malformed JSON is rejected');
  assert.equal(readNewTerminalCommand(newTerminalCommand({ space: 'nope', folder: '/w' }), spaces).ok, false);
  assert.equal(readNewTerminalCommand(newTerminalCommand({ space: 'local-space', folder: '' }), spaces).ok, false);
  assert.equal(readNewTerminalCommand(newTerminalCommand({ space: 'remote-space', folder: '/w', machine: null }), spaces).ok, false);
});

// ---- launcher availability (§3.6) ----

const agentsPackage = { mod: 'herdr-zed-agents', id: 'agents', services: [{ view: 'service' }], provides: { launcher } };
const serviceNode = (mod, view) => ({ id: `zed-extension-service-${mod}-${view}`, type: 'block', content: { mod, props: { view } } });
const rootWith = (...children) => ({ id: 'root', type: 'column', children: [{ id: 'status-separator', type: 'row', children }] });

test('a launcher is available only while every declared service is mounted in the layout', () => {
  const resolved = { mod: 'herdr-zed-agents', id: 'agents', ...launcher };
  assert.equal(launcherAvailable(resolved, [agentsPackage], rootWith(serviceNode('herdr-zed-agents', 'service'))), true);
  assert.equal(launcherAvailable(resolved, [agentsPackage], rootWith()), false, 'declared but not mounted');
  assert.equal(launcherAvailable(resolved, [agentsPackage], rootWith(serviceNode('herdr-zed-agents', 'sidebar'))), false, 'another view of the mod is not its service');
  assert.equal(launcherAvailable(resolved, [agentsPackage], rootWith(serviceNode('herdr-zed-tasks', 'service'))), false, 'another mod is not the launcher');
  const nested = { id: 'root', type: 'column', children: [{ id: 'deep', type: 'row', children: [serviceNode('herdr-zed-agents', 'service')] }] };
  assert.equal(launcherAvailable(resolved, [agentsPackage], nested), true, 'the service may sit anywhere in the layout');
  const twoServices = { ...agentsPackage, services: [{ view: 'service' }, { view: 'usage' }] };
  assert.equal(launcherAvailable(resolved, [twoServices], rootWith(serviceNode('herdr-zed-agents', 'service'))), false, 'every declared service must be mounted');
  assert.equal(launcherAvailable(resolved, [twoServices], rootWith(serviceNode('herdr-zed-agents', 'service'), serviceNode('herdr-zed-agents', 'usage'))), true);
});

test('no launcher, no layout or no package never counts as available', () => {
  const resolved = { mod: 'herdr-zed-agents', id: 'agents', ...launcher };
  assert.equal(launcherAvailable(null, [agentsPackage], rootWith(serviceNode('herdr-zed-agents', 'service'))), false);
  assert.equal(launcherAvailable(resolved, [agentsPackage], null), false);
  assert.equal(launcherAvailable(resolved, [], rootWith(serviceNode('herdr-zed-agents', 'service'))), false);
  assert.equal(launcherAvailable(resolved, [{ ...agentsPackage, services: [] }], rootWith()), true, 'a package that declares no service has nothing to mount');
});

test('every extension.json under mods/ parses with the real manifest parser', async () => {
  const modsDir = fileURLToPath(new URL('../mods/', import.meta.url));
  for (const entry of await readdir(modsDir)) {
    const file = join(modsDir, entry, 'extension.json');
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const text = await readFile(file, 'utf8');
    assert.doesNotThrow(() => extensionMetadata(entry, text), entry);
    assert.doesNotThrow(() => parseExtensionManifest(entry, text), entry);
  }
});
