// Keep the executable entry outside the library: project/runtime imports also use that library.
import { isMain } from './node-main.js';
import { readSharedLibrary, prepareSharedGuidance, importSharedSkill } from './shared-skills.js';

if (await isMain(import.meta.url)) {
  try {
    const [action, home, ...args] = process.argv.slice(2);
    let result = action === 'list' ? await readSharedLibrary(home)
      : ['prepare', 'commands'].includes(action) ? await prepareSharedGuidance(home, args[0], args[1] || null, JSON.parse(args[2] || '{}'))
      : action === 'import' ? await importSharedSkill(home, args[0], args[1] || null) : (() => { throw Error('Unknown shared skills action.'); })();
    if (action === 'commands') result = (result?.commands || []).map(({ path, ...command }) => command);
    if (action === 'prepare' && args[3]) {
      const { prepareSharedPlugin } = await import('./shared-skills-runtime.js');
      const flags = await prepareSharedPlugin(home, args[0], args[3], result?.nativeSkills || []);
      result = { ...result, flags };
    }
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
