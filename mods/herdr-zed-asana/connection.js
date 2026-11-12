import { appHome, readTextFile, writeTextFile } from 'herdr';
const tokenPath = () => `${appHome()}/data/herdr-zed/asana.json`;
export async function readAsanaToken() {
  try { return JSON.parse(await readTextFile(tokenPath()) || 'null')?.token || null; } catch { return null; }
}

export async function saveAsanaToken(token) {
  const current = await readTextFile(tokenPath());
  await writeTextFile(tokenPath(), `${JSON.stringify({ token }, null, 2)}\n`, current);
}
