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
