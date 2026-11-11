// Import target discovery. The importer is whichever enabled package the shell catalog declares for
// task snapshots; this extension never names or imports the importer's code.
export const importKind = 'task-snapshot';

// { mod, title, view } of the first usable importer, or null (the import action is then hidden).
export function importTarget(catalog) {
  const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
  const entry = packages.find(item => item && item.enabled !== false && !item.error
    && item.provides?.importer?.accepts?.includes(importKind));
  return entry ? { mod: entry.mod, title: entry.title || entry.mod, view: entry.provides.importer.view } : null;
}

// Standalone browsers open the importer as a dialog. The snapshot carries explicit domain fields only.
export function importRequest(target, { source, context, snapshot }) {
  return { mod: target.mod, kind: 'dialog', frame: 'none', modal: true, width: 760, height: 400,
    props: { view: target.view, kind: importKind, source, context, snapshot } };
}
