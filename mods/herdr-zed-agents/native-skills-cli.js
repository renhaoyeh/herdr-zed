import { isMain } from './node-main.js';
import { nativeSkillInventory, nativeSkillFlags, saveNativeSkillPolicy, scanNativeSkills, installNativeSkill, setNativeSkillEnabled } from './native-skills.js';

if (await isMain(import.meta.url)) {
  try {
    const [action, home, payload] = process.argv.slice(2), args = JSON.parse(payload || '{}');
    const result = action === 'inventory' ? await nativeSkillInventory(home, args.userHome, args.provider, args.directory, args.folder)
      : action === 'prepare' ? await nativeSkillFlags(home, args.folder, args.provider, args.directory, { userHome: args.userHome })
      : action === 'save' ? await saveNativeSkillPolicy(home, args.folder, args.provider, args.disabled, args.revision)
      : action === 'scan' ? await scanNativeSkills(home, args.source)
      : action === 'install' ? await installNativeSkill(args.userHome, args.provider, args.source)
      : action === 'enable' ? await setNativeSkillEnabled(args.userHome, args.provider, args.directory, args.path, args.enabled, args.expected)
      : (() => { throw Error('Unknown native skill action.'); })();
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
