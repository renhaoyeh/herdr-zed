import { readFile } from 'node:fs/promises';

export async function evaluateNative(path, host, names) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const declared = new Set([...source.matchAll(/^(?:export (?:default )?)?(?:(?:async )?function|class|const|let)\s+(\w+)/gm)].map(match => match[1]));
  const bindings = Object.entries(host).filter(([name]) => !declared.has(name));
  return new Function(...bindings.map(([name]) => name), source.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\}(?: from .*)?;\r?\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '') + `\nreturn { ${names} };`)(...bindings.map(([, value]) => value));
}

// Consumer-side binding/state callbacks, supplied explicitly rather than read by a provider.
export function sourceOptions(host, key, target = {}) {
  const identity = folder => JSON.stringify(['', host.folderKey(folder)]);
  const save = (folder, binding) => host.setShared(`devkits.${key}-projects`, {
    ...(host.shared(`devkits.${key}-projects`) || {}), [identity(folder)]: binding,
  });
  return { importLabel: 'Import into Tasks',
    state: { get: suffix => host.shared(`devkits.${key}-${suffix}`), set: (suffix, value) => host.setShared(`devkits.${key}-${suffix}`, value) },
    getBinding: folder => host.shared(`devkits.${key}-projects`)?.[identity(folder)] || null,
    setBinding: save,
    onSelect: project => save(target.folder, { gid: project.gid, name: project.name, workspace: project.workspaceGid,
      ...(key === 'mantisbt' ? { server: project.server } : {}) }),
    onClose: () => host.closeOverlay?.(target.overlay),
  };
}
