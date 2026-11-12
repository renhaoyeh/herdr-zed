import { appHome, readTextFile, writeTextFile } from 'herdr';
import { normalizeUrl } from './rest.js';
const connectionPath = () => `${appHome()}/data/herdr-zed/mantisbt.json`;
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

// Fetched issue lists live in their own file so reading credentials never loads them.
const issuesPath = () => `${appHome()}/data/herdr-zed/mantisbt-issues.json`;
const tokenKey = token => { let hash = 5381; for (const char of String(token)) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0; return String(hash); };
const issuesKey = (connection, project) => `${normalizeUrl(connection.url)}|${project}`;

export async function readMantisIssues(connection, project) {
  try {
    const entry = JSON.parse(await readTextFile(issuesPath()) || 'null')?.entries?.[issuesKey(connection, project)];
    if (!entry || entry.token !== tokenKey(connection.token) || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.tasks)) return null;
    return { fetchedAt: entry.fetchedAt, tasks: entry.tasks };
  } catch { return null; }
}

export async function saveMantisIssues(connection, project, tasks, fetchedAt) {
  const current = await readTextFile(issuesPath());
  let saved = null; try { saved = JSON.parse(current || 'null'); } catch {}
  const entries = { ...(saved?.entries || {}), [issuesKey(connection, project)]: { fetchedAt, token: tokenKey(connection.token), tasks } };
  // Keep the five most recent lists.
  const kept = Object.fromEntries(Object.entries(entries).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, 5));
  await writeTextFile(issuesPath(), `${JSON.stringify({ entries: kept })}
`, current);
}
