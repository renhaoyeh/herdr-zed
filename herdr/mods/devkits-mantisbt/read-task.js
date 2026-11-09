import { readFile } from 'node:fs/promises';
import { taskDetails, taskComments, normalizeUrl } from './source-api.js';
try {
  const [appHome, gid, project, expectedServer] = process.argv.slice(2);
  const connection = JSON.parse(await readFile(`${appHome}/data/devkits/mantisbt.json`, 'utf8'));
  if (!connection?.token) throw new Error('Connect MantisBT to read this task.');
  if (expectedServer && normalizeUrl(connection.url) !== normalizeUrl(expectedServer)) throw new Error('Connect the original MantisBT server to read this task.');
  const task = await taskDetails(connection, gid, project || null);
  if (!task || task.completed) throw new Error('This task was completed or deleted.');
  try { task.comments = await taskComments(connection, gid); }
  catch (error) { task.comments = []; task.commentsError = error.message; }
  console.log(JSON.stringify(task));
} catch (error) { console.log(JSON.stringify({ error: error.code === 'ENOENT' ? 'Connect MantisBT to read this task.' : error.message })); process.exitCode = 1; }
