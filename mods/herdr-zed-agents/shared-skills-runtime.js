import { buildSharedPackage } from './shared-skills.js';
import { openConfig } from './codex-config.js';
import { runPlugin, withEccAccountLock } from './ecc-sync.js';

// A native package belongs to one invocation. Cached Codex registrations stay disabled.
export async function prepareSharedPlugin(home, provider, directory, skills, { configService = openConfig, run = runPlugin, build = buildSharedPackage } = {}) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Choose claude or codex.');
  const bundle = await build(home, provider, skills);
  if (provider === 'claude') return bundle ? ['--plugin-dir', bundle.root] : [];
  const flags = [];
  await withEccAccountLock(directory, async () => {
    let installed = false;
    const service = await configService(directory);
    try {
      for (const id of Object.keys(service.config.plugins || {})) if (/^shared-skills@herdr-zed-shared-skills-[a-f0-9]{16}$/.test(id))
        flags.push('-c', `plugins.${id}.enabled=false`);
      installed = Boolean(bundle && service.config.plugins?.[bundle.pluginId]);
    } finally { await service.close(); }
    if (bundle) {
      try {
        if (!installed) await run('codex', directory, ['-c', `marketplaces.${bundle.marketplace}={source_type="local",source=${JSON.stringify(bundle.root)}}`, 'plugin', 'add', bundle.pluginId, '--json']);
      } finally {
        const restore = await configService(directory);
        try {
          if (restore.config.plugins?.[bundle.pluginId] && restore.config.plugins[bundle.pluginId].enabled !== false)
            await restore.write([{ keyPath: `plugins.${JSON.stringify(bundle.pluginId)}.enabled`, value: false, mergeStrategy: 'replace' }]);
        } finally { await restore.close(); }
      }
      flags.push('-c', `marketplaces.${bundle.marketplace}={source_type="local",source=${JSON.stringify(bundle.root)}}`, '-c', `plugins.${bundle.pluginId}.enabled=true`);
    }
  });
  return flags;
}
