import { mkdir, cp, readFile, writeFile, rename, rm, mkdtemp, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { eccHash, readEccCatalog } from './ecc-catalog.js';
import { eccItemEnabled } from './ecc-model.js';

const mcpRunner = `const fs=require('fs'),path=require('path'),cp=require('child_process');
try {
 const all=JSON.parse(fs.readFileSync(path.join(__dirname,'devkits-mcp.json'),'utf8'));
 const server=all[process.argv[2]];if(!server)throw Error('Unknown ECC MCP server');
 const expand=(value,key)=>String(value).replace(/YOUR_[A-Z0-9_]+/g,()=>{if(!key||!process.env[key])throw Error('Missing environment variable: '+key);return process.env[key]}).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g,(_,name)=>{if(!process.env[name])throw Error('Missing environment variable: '+name);return process.env[name]});
 const env={...process.env};for(const [key,value] of Object.entries(server.env||{}))env[key]=expand(value,key);
 const args=(server.args||[]).map(value=>expand(value));
 const command=expand(server.command);const win=process.platform==='win32';
 const child=win?cp.spawn('git',['-c','alias.devkits-shell=!sh','devkits-shell','-c','exec "$@"','ecc-mcp',command,...args],{env,stdio:'inherit',windowsHide:true}):cp.spawn(command,args,{env,stdio:'inherit'});
 child.on('error',()=>{process.stderr.write('ECC MCP could not start its executable\\n');process.exitCode=1});child.on('exit',(code)=>{process.exitCode=code||0});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}catch(error){process.stderr.write(error.message+'\\n');process.exitCode=1}
`;

export async function buildEccPackage(config, provider, outputDirectory, suppliedCatalog, { project = false } = {}) {
  const catalog = suppliedCatalog || await readEccCatalog(config.source);
  const outputRelation = relative(catalog.source, resolve(outputDirectory));
  if (!outputRelation || (!isAbsolute(outputRelation) && outputRelation !== '..' && !outputRelation.startsWith(`..${sep}`))) throw new Error('ECC package output must be outside its source directory.');
  const applicable = catalog.items.filter(item => item.providers.includes(provider));
  const selected = applicable.filter(item => eccItemEnabled(config, provider, item));
  const invalid = selected.find(item => item.unavailable);
  if (invalid) throw new Error(`${invalid.name}：${invalid.unavailable}`);
  if (selected.filter(item => item.group === 'contexts').length > 1) throw new Error('Select at most one Context working mode per provider.');
  const revision = eccHash(JSON.stringify({ compiler: 1, ...(project ? { project: true } : {}), source: catalog.source, sourceRevision: catalog.sourceRevision, provider,
    selected: selected.map(item => item.id).sort(), claudeHooks: provider === 'claude' ? config.claudeHooks : null }));
  const marketplace = `herdr-zed-${project ? 'project-' : ''}ecc-${revision.slice(0, 16)}`, pluginId = `ecc@${marketplace}`;
  const root = resolve(outputDirectory, revision);
  const instructions = (await Promise.all(selected.filter(item => ['rules', 'contexts'].includes(item.group))
    .map(async item => `## ${item.path}\n\n${await readFile(join(catalog.source, item.path), 'utf8')}`))).join('\n\n');
  const nativeItems = selected.filter(item => !['rules', 'contexts'].includes(item.group) && !item.checkId
    && !(provider === 'claude' && item.group === 'hooks' && config.claudeHooks === 'off'));
  const result = { root, revision, marketplace, pluginId, instructions, native: nativeItems.length > 0,
    selected: selected.length, version: catalog.version };
  try {
    const existing = JSON.parse(await readFile(join(root, 'devkits-package.json'), 'utf8'));
    if (existing.revision === revision) return result;
    throw new Error('ECC package revision mismatch.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(outputDirectory, { recursive: true });
  const stage = await mkdtemp(join(resolve(outputDirectory), '.building-'));
  try {
    await cp(catalog.source, stage, { recursive: true, filter: async path => {
      const rel = relative(catalog.source, path).replaceAll('\\', '/');
      return !rel.split('/').some(part => ['.git', 'node_modules'].includes(part)) && !(await lstat(path)).isSymbolicLink();
    } });
    for (const item of applicable) {
      if (!['skills', 'agents', 'commands', 'workflows'].includes(item.group) || eccItemEnabled(config, provider, item)) continue;
      // Keep skill scripts/resources available to hooks; remove only the native discovery entry.
      await rm(join(stage, item.path), { force: true });
    }
    const disabledChecks = applicable.filter(item => item.checkId && !eccItemEnabled(config, provider, item)).map(item => item.checkId);
    if (disabledChecks.length) {
      const flagsPath = join(stage, 'scripts/lib/hook-flags.js');
      const original = await readFile(flagsPath, 'utf8'), marker = 'const disabled = getDisabledHookIds(env);';
      if (!original.includes(marker)) throw new Error('This ECC source does not expose the expected per-hook controls.');
      await writeFile(flagsPath, original.replace(marker, `${marker}\n  for (const id of ${JSON.stringify(disabledChecks)}) disabled.add(id);`));
    }
    for (const [host, path] of [['claude', 'hooks/hooks.json'], ['codex', 'hooks/codex-hooks.json']]) {
      let original;
      try { original = JSON.parse(await readFile(join(stage, path), 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const hooks = {};
      for (const item of selected.filter(item => item.native && item.providers.includes(host))) {
        if (host === 'claude' && config.claudeHooks === 'off') continue;
        (hooks[item.event] ||= []).push(item.payload);
      }
      await writeFile(join(stage, path), `${JSON.stringify({ ...original, hooks }, null, 2)}\n`);
    }
    const servers = {}, wrapped = {};
    for (const item of selected.filter(item => item.group === 'mcp')) {
      const { description, ...server } = item.payload;
      if (server.command) {
        wrapped[item.name] = server;
        servers[item.name] = { command: 'node', args: [join(root, 'scripts/devkits-mcp.cjs'), item.name] };
      } else servers[item.name] = server;
    }
    await mkdir(join(stage, 'scripts'), { recursive: true });
    await writeFile(join(stage, 'scripts/devkits-mcp.cjs'), mcpRunner);
    await writeFile(join(stage, 'scripts/devkits-mcp.json'), `${JSON.stringify(wrapped, null, 2)}\n`);
    await writeFile(join(stage, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    for (const host of ['claude', 'codex']) {
      const path = join(stage, `.${host}-plugin/plugin.json`);
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, `${JSON.stringify({ ...manifest, mcpServers: './.mcp.json' }, null, 2)}\n`);
    }
    const claudeMarket = { name: marketplace, owner: { name: 'Herdr Devkits' }, plugins: [{ name: 'ecc', source: './', version: catalog.version }] };
    const codexMarket = { name: marketplace, interface: { displayName: 'ECC · Devkits selection' }, plugins: [{ name: 'ecc', source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] };
    await mkdir(join(stage, '.agents/plugins'), { recursive: true });
    await writeFile(join(stage, '.claude-plugin/marketplace.json'), JSON.stringify(claudeMarket, null, 2));
    await writeFile(join(stage, '.agents/plugins/marketplace.json'), JSON.stringify(codexMarket, null, 2));
    await writeFile(join(stage, 'devkits-guidance.md'), instructions);
    await writeFile(join(stage, 'devkits-package.json'), JSON.stringify({ revision, provider, selected: selected.map(item => item.id) }, null, 2));
    try { await rename(stage, root); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const winner = JSON.parse(await readFile(join(root, 'devkits-package.json'), 'utf8'));
      if (winner.revision !== revision) throw error;
    }
    return result;
  } finally {
    if (!resolve(stage).startsWith(`${resolve(outputDirectory)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Invalid ECC staging directory.');
    await rm(stage, { recursive: true, force: true });
  }
}
