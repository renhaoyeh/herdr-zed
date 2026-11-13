// Shared: edit components/contract-types.d.ts, then npm run sync:shared.
// Typed provider contract (ARCHITECTURE.md §2–§3). Shell and providers check against these with `npm run typecheck`.

export type ExtensionId = string;

export interface PopupDimensions { view: string; width: number; height: number; }

export interface LauncherProvider {
  picker: { view: string; width: number };
}
export type DecorationField = 'badge' | 'subtitle' | 'tone';
export interface ThreadDecoratorProvider { fields: DecorationField[]; }
export interface ImporterProvider { accepts: 'task-snapshot'[]; view: string; }
export type GitCredentialsProvider = Record<string, never>;

export interface Provides {
  launcher?: LauncherProvider;
  threadDecorator?: ThreadDecoratorProvider;
  importer?: ImporterProvider;
  gitCredentials?: GitCredentialsProvider;
}

export type Platform = 'macos' | 'windows' | 'linux';

export interface ExtensionAction {
  id: string; title: string; icon: string; iconColor?: string;
  location: 'status.right' | 'git.actions';
  /** ARCHITECTURE §2.1: `workspace` opens a popup over the work area (width and height are then ignored). */
  popup: PopupDimensions & { modal: boolean; placement?: 'center' | 'workspace' };
}
export interface ExtensionSurface {
  id: string; location: 'sidebar.bottom' | 'status.right' | 'dock.right';
  view: string; title: string; icon: string;
}
/** ARCHITECTURE §2.1: a sub-item under a UI extension's Settings entry. */
export interface ExtensionSettingsPage { id: string; title: string; icon?: string; /** Labels the run of pages it starts in a settings nav. */ group?: string; }
/** ARCHITECTURE §2.1: a UI extension's page in the shell's Settings dialog. */
export interface ExtensionSettings { view: string; title: string; pages?: ExtensionSettingsPage[]; }
export interface ExtensionManifest {
  version: 1; id: ExtensionId; title: string;
  /** One sentence on what it does, shown in the Extensions manager (≤ 160 chars). */
  description?: string;
  /** Extensions manager group; default 'tools'. */
  category?: 'work' | 'sources' | 'git' | 'tools';
  dataReset?: { helper: string } | null;
  platforms?: Platform[];
  dependencies?: string[]; requires?: ExtensionId[];
  services?: { view: string }[]; surfaces?: ExtensionSurface[];
  actions: ExtensionAction[]; provides?: Provides; settings?: ExtensionSettings;
}

/** §3.1 provider → shell, appended to `herdr-zed.launch.requests`. */
export interface LaunchTarget {
  space?: string | null; folder: string; projectName?: string; machine?: string | null; overlay?: string;
}
/** Optional provider record a launch belongs to; echoed into the thread read model. */
export interface LaunchOrigin { extension: ExtensionId; ref: string; }
export interface LaunchRequest {
  id: string; source: ExtensionId; target: LaunchTarget;
  name: string; argv: string[]; profile: string | null; expiresAt: number; origin?: LaunchOrigin;
  /** The agent's first message (Herdr tab.new/space.new `task`). */
  task?: string;
}
/** §3.1 Composer: launcher → shell, `herdr-zed.composer.<extension id>`. */
export type ComposerField =
  | { id: string; label: string; type: 'select'; value: string; options: { key: string; label: string; only?: Record<string, string[]> }[] }
  | { id: string; label: string; type: 'toggle'; value: boolean };
/** `detail`: a short reading beside the choice (e.g. its account's quota); `tone` colours it. */
export interface ComposerChoice { key: string; label: string; icon?: string; tint?: boolean; fields: ComposerField[]; }
export interface ComposerUsageWindow { label: string; minutes: number; usedPercent: number; resetsAt: number | null; }
export interface ComposerUsage { key: string; label: string; icon?: string; tint?: boolean; muted?: boolean; menu?: { view: string; width: number }; windows: ComposerUsageWindow[]; }
export interface ComposerEnvelope { updatedAt: number; machines: Record<string, { choices: ComposerChoice[]; usage?: ComposerUsage[] }>; }
/** §3.1 Composer: shell → launcher, appended to `herdr-zed.launch.intents`. */
export interface LaunchIntent {
  id: string; launcher: ExtensionId; target: LaunchTarget; choice: string;
  values: Record<string, string | boolean>; task?: string; expiresAt: number;
}
export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** §3.3 provider → shell, `herdr-zed.decorations.<extension id>`. */
export interface ThreadDecoration { badge?: string; subtitle?: string; tone?: 'muted' | 'accent' | 'warning' | 'error'; }
/** §3.1 shell-side read model, `herdr-zed.threads`: tab ID → what launched it. */
export interface ThreadRecord { profile: string | null; source: ExtensionId; origin?: LaunchOrigin; replaces?: string; }
export interface DecorationEnvelope { updatedAt: number; threads: Record<string, ThreadDecoration>; }

/** §3.5 provider → shell, `herdr-zed.git-credentials.<extension id>`. */
export interface GitCredentialBinding { host: string; login: string; config: [string, string][]; }
export interface GitCredentialEnvelope { updatedAt: number; repositories: Record<string, GitCredentialBinding>; }
