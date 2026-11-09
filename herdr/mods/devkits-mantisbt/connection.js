import { appHome, readTextFile, writeTextFile } from 'herdr';
import { normalizeUrl } from './api.js';
const connectionPath = () => `${appHome()}/data/devkits/mantisbt.json`;
export async function readMantisConnection() {
  try {
    const connection = JSON.parse(await readTextFile(connectionPath()) || 'null');
    return connection?.token && connection?.url ? { url: normalizeUrl(connection.url), token: connection.token } : null;
  } catch { return null; }
}

export async function saveMantisConnection(connection) {
  const current = await readTextFile(connectionPath());
  await writeTextFile(connectionPath(), `${JSON.stringify({ url: connection.url, token: connection.token }, null, 2)}\n`, current);
}

const sameConnection = (saved, connection) => saved?.token === connection.token && saved?.url === normalizeUrl(connection.url);

export async function readMantisProjects(connection) {
  try {
    const saved = JSON.parse(await readTextFile(connectionPath()) || 'null'), cache = saved?.projectCache;
    if (!sameConnection(saved, connection) || !cache || !Number.isFinite(cache.fetchedAt) || cache.fetchedAt <= 0 ||
      !Array.isArray(cache.projects) || !cache.projects.every(project => typeof project.gid === 'string' &&
        typeof project.name === 'string' && typeof project.workspace === 'string' &&
        project.workspaceGid === project.gid && project.server === saved.url)) return null;
    return cache;
  } catch { return null; }
}

export async function saveMantisProjects(connection, projects, fetchedAt) {
  const current = await readTextFile(connectionPath()), saved = JSON.parse(current || 'null');
  // A late response must not replace credentials changed or cleared in another window.
  if (!sameConnection(saved, connection)) return;
  const compact = projects.map(({ gid, name, workspace, workspaceGid, server }) => ({ gid, name, workspace, workspaceGid, server }));
  await writeTextFile(connectionPath(), `${JSON.stringify({ ...saved, projectCache: { fetchedAt, projects: compact } }, null, 2)}\n`, current);
}
