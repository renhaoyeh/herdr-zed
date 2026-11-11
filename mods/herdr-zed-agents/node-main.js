import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Node canonicalizes module URLs. Canonicalize argv too: /tmp and /private/tmp (or a symlinked install) name the same entry.
export async function isMain(url) {
  if (!process.argv[1]) return false;
  try { return await realpath(process.argv[1]) === await realpath(fileURLToPath(url)); }
  catch { return false; } // A virtual entry such as stdin is not this file.
}
