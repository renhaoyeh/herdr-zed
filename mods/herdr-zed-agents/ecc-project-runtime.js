import { isMain } from './node-main.js';
import { join } from 'node:path';
import { readProjectState, projectIdentity, projectPolicyPath, optionalText, effectiveProjectPolicy } from './ecc-project.js';
import { buildEccPackage } from './ecc-package.js';
import { openConfig } from './codex-config.js';
import { runPlugin, withEccAccountLock } from './ecc-sync.js';

// Codex requires a native cache installation. Register project packages disabled by default,
// then activate only through invocation flags. Global and project setup share the account lock.
export async function prepareProjectEcc(home, folder, provider, directory, { configService = openConfig, packageBuilder = buildEccPackage, run = runPlugin, ...options } = {}) {
  const identity = await projectIdentity(folder);
  if (await optionalText(projectPolicyPath(home, identity)) === null) return null;
  const state = await readProjectState(home, folder, options);
  if (!state.policy.providers[provider]) return null;
  const policy = effectiveProjectPolicy(state, provider);
  if (policy.enabled && state.catalog.error) throw Error(`ECC source is unavailable: ${state.catalog.error}`);
  const config = { ...state.config, enabled: policy.enabled, claudeHooks: policy.claudeHooks,
    providerEnabled: { claude: true, codex: true }, selection: { ...state.config.selection, [provider]: policy.selection } };
  const bundle = policy.enabled ? await packageBuilder(config, provider, join(home, 'data', 'herdr-zed', 'ecc-packages'), state.catalog, { project: true }) : null;
  const flags = [];
  if (provider === 'codex') {
    await withEccAccountLock(directory, async () => {
      let installed = false;
      const service = await configService(directory);
      try {
        if (bundle && service.config.plugins?.['ecc@ecc']?.enabled === true) throw Error('Disable the external ecc@ecc plugin before using project ECC.');
        for (const id of Object.keys(service.config.plugins || {})) if (/^ecc@herdr-zed-(?:project-)?ecc-[a-f0-9]{16}$/.test(id))
          // CLI override paths split on dots; unlike config/batchWrite, quoted keys are literal.
          flags.push('-c', `plugins.${id}.enabled=false`);
        installed = Boolean(bundle?.native && service.config.plugins?.[bundle.pluginId]);
      } finally { await service.close(); }
      if (bundle?.native) {
        try {
          if (!installed) await run('codex', directory, ['-c', `marketplaces.${bundle.marketplace}={source_type="local",source=${JSON.stringify(bundle.root)}}`, 'plugin', 'add', bundle.pluginId, '--json']);
        } finally {
          // The native installer writes enabled=true, even over a pre-existing false entry.
          // Never leave that activation as an account default, including after an install error.
          const restore = await configService(directory);
          try {
            if (restore.config.plugins?.[bundle.pluginId]?.enabled !== false && restore.config.plugins?.[bundle.pluginId])
              await restore.write([{ keyPath: `plugins.${JSON.stringify(bundle.pluginId)}.enabled`, value: false, mergeStrategy: 'replace' }]);
          } finally { await restore.close(); }
        }
      }
    });
    if (bundle?.native) flags.push('-c', `marketplaces.${bundle.marketplace}={source_type="local",source=${JSON.stringify(bundle.root)}}`,
      '-c', `plugins.${bundle.pluginId}.enabled=true`);
  } else if (provider === 'claude') {
    const settings = JSON.parse(await optionalText(join(directory, 'settings.json')) || '{}');
    if (bundle && settings.enabledPlugins?.['ecc@ecc'] === true) throw Error('Disable the external ecc@ecc plugin before using project ECC.');
    const enabledPlugins = Object.fromEntries(Object.keys(settings.enabledPlugins || {}).filter(id => /^ecc@herdr-zed-(?:project-)?ecc-[a-f0-9]{16}$/.test(id)).map(id => [id, false]));
    if (Object.keys(enabledPlugins).length) flags.push('--settings', JSON.stringify({ enabledPlugins }));
    if (bundle?.native) flags.push('--plugin-dir', bundle.root);
  } else throw Error('Unsupported project provider.');
  for (const name of Object.keys(policy.mcp)) if (!Object.hasOwn(state.mcp.servers, name)) throw Error(`${name}: project connection is no longer configured. Review the project settings.`);
  return { flags, mcp: policy.mcp, instructionsFile: bundle?.instructions ? join(bundle.root, 'devkits-guidance.md') : null };
}

if (await isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareProjectEcc(...process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
