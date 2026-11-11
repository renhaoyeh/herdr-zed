import { isMain } from './node-main.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEccCatalog, eccCatalogForUi, readEccDetail } from './ecc-catalog.js';
import { buildEccPackage } from './ecc-package.js';
import { parseEcc } from './ecc-model.js';
import { readFile } from 'node:fs/promises';

if (await isMain(import.meta.url)) {
  try {
    const [action, value, extra] = process.argv.slice(2);
    if (action === 'catalog') console.log(JSON.stringify(eccCatalogForUi(await readEccCatalog(value))));
    else if (action === 'detail') console.log(JSON.stringify({ text: await readEccDetail(await readEccCatalog(value), extra) }));
    else if (action === 'validate-file') {
      const config = parseEcc(await readFile(value, 'utf8')), catalog = await readEccCatalog(config.source);
      const output = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'devkits', 'ecc-packages');
      if (config.enabled) for (const provider of ['claude', 'codex']) if (config.providerEnabled[provider]) await buildEccPackage(config, provider, output, catalog);
      console.log(JSON.stringify({ version: catalog.version, sourceRevision: catalog.sourceRevision }));
    } else throw new Error('Unsupported ECC operation.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
