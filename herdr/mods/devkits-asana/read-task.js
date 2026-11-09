import { readFile } from 'node:fs/promises';
import { taskDetails, taskComments } from './source-api.js';
try {
  const [appHome, gid, project] = process.argv.slice(2);
  const connection = JSON.parse(await readFile(`${appHome}/data/devkits/asana.json`, 'utf8'));
  if (!connection?.token) throw new Error('Connect Asana to read this task.');
  const task = await taskDetails(connection.token, gid, project || null);
  if (!task || task.completed) throw new Error('This task was completed or deleted.');
  try { task.comments = await taskComments(connection.token, gid); }
  catch (error) { task.comments = []; task.commentsError = error.message; }
  console.log(JSON.stringify(task));
} catch (error) { console.log(JSON.stringify({ error: error.code === 'ENOENT' ? 'Connect Asana to read this task.' : error.message })); process.exitCode = 1; }
