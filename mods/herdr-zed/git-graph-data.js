import { exec } from 'herdr';
import { execShell } from './shell.js';

const GRAPH_PAGE = 100;
// Windows caps a command line at 32,767 characters; leave room for the other arguments.
const TIP_ARGUMENT_LIMIT = 20000;

/** Run git log over the snapshot tips, piping them through --stdin when they would overflow the command line. */
function graphLog(folder, on, snapshot, args) {
  if (snapshot.tips.join(' ').length <= TIP_ARGUMENT_LIMIT) {
    return exec('git', ['-C', folder, '-c', 'log.showSignature=false', '--no-pager', 'log', ...args, ...snapshot.tips, '--'], { on });
  }
  // Too many refs to pass as arguments: read the same ref set inside the shell instead.
  return execShell(['-c', 'cd "$1" || exit 2; shift; '
    + '{ git rev-parse --verify -q HEAD; git for-each-ref --format="%(objectname)" refs/heads refs/remotes refs/tags; } '
    + '| git -c log.showSignature=false --no-pager log --stdin "$@" --', 'herdr-zed-graph', folder, ...args], { on });
}
const graphSha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || '');

export function graphDate(at, relative = true, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const date = new Date(at * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  if (!relative) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const seconds = Math.max(0, Math.floor(now / 1000 - at));
  if (seconds < 60) return 'just now';
  const [value, unit] = seconds < 3600 ? [Math.floor(seconds / 60), 'minute'] : seconds < 86400 ? [Math.floor(seconds / 3600), 'hour']
    : seconds < 604800 ? [Math.floor(seconds / 86400), 'day'] : seconds < 2592000 ? [Math.floor(seconds / 604800), 'week']
      : seconds < 31536000 ? [Math.floor(seconds / 2592000), 'month'] : [Math.floor(seconds / 31536000), 'year'];
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/** Snapshot all branch/tag tips once, so paging cannot move when refs change. */
export async function readGraphSnapshot(folder, on) {
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a Git repository." >&2; exit 3; }; '
    + 'head=$(git rev-parse --verify -q HEAD); branch=$(git symbolic-ref --short -q HEAD); '
    + 'printf "%s\\0%s\\0" "$head" "$branch"; '
    + 'git for-each-ref --format="%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(refname)%00" refs/heads refs/remotes refs/tags',
    'herdr-zed-graph', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read Git refs.');
  const [head, branch, ...fields] = result.stdout.split('\0');
  const refs = {}, tips = new Set(graphSha(head) ? [head] : []);
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const sha = fields[i + 2] === 'commit' ? fields[i].trim() : fields[i + 3] === 'commit' ? fields[i + 1] : null;
    const full = fields[i + 4];
    if (!graphSha(sha) || /refs\/remotes\/.*\/HEAD$/.test(full)) continue;
    tips.add(sha);
    const kind = full.startsWith('refs/tags/') ? 'tag' : full.startsWith('refs/remotes/') ? 'remote' : 'branch';
    const name = full.replace(/^refs\/(heads|remotes|tags)\//, '');
    (refs[sha] ||= []).push({ name, kind, head: kind === 'branch' && name === branch });
  }
  // A detached HEAD has no branch decoration of its own.
  if (graphSha(head) && !branch) (refs[head] ||= []).unshift({ name: 'HEAD', kind: 'head', head: true });
  return { head: graphSha(head) ? head : null, branch, tips: [...tips], refs, revision: result.stdout };
}

export function parseGraphCommits(text) {
  const fields = text.split('\0'), entries = [];
  for (let i = 0; i + 6 < fields.length; i += 7) {
    if (!graphSha(fields[i])) continue;
    const message = fields[i + 6].trimEnd().slice(0, 12000);
    entries.push({ sha: fields[i], shortSha: fields[i + 1], author: fields[i + 2], email: fields[i + 3],
      at: Number(fields[i + 4]), parents: fields[i + 5].split(' ').filter(graphSha),
      subject: message.split('\n')[0] || '(No commit message)', message });
  }
  return entries;
}

export async function readGraphPage(folder, on, snapshot = null, skip = 0) {
  if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid graph offset.');
  snapshot ||= await readGraphSnapshot(folder, on);
  if (!snapshot.tips.every(graphSha)) throw new Error('Invalid graph revision.');
  if (!snapshot.tips.length) return { snapshot, entries: [], hasMore: false };
  const result = await graphLog(folder, on, snapshot, ['--no-color', '--topo-order', '-z',
    '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%B', `--max-count=${GRAPH_PAGE + 1}`, `--skip=${skip}`]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read Git graph.');
  const entries = parseGraphCommits(result.stdout);
  return { snapshot, entries: entries.slice(0, GRAPH_PAGE), hasMore: entries.length > GRAPH_PAGE };
}

/** Search messages and authors with literal Git patterns, plus exact/prefix commit IDs. */
export async function searchGraph(folder, on, snapshot, query, matchCase) {
  if (!query || !snapshot?.tips.length) return [];
  if (!snapshot.tips.every(graphSha)) throw new Error('Invalid graph revision.');
  const base = ['--no-color', '--format=%H', '--fixed-strings', ...(!matchCase ? ['--regexp-ignore-case'] : [])];
  const results = await Promise.all(['--grep=', '--author='].map(flag => graphLog(folder, on, snapshot, [...base, flag + query])));
  const matches = new Set();
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot search commits.');
    for (const sha of result.stdout.trim().split('\n')) if (graphSha(sha)) matches.add(sha);
  }
  if (/^[a-fA-F0-9]{4,64}$/.test(query)) {
    const result = await exec('git', ['-C', folder, 'rev-parse', '--verify', '--quiet', `${query}^{commit}`], { on });
    const sha = result.stdout.trim();
    if (result.code === 0 && graphSha(sha)) matches.add(sha);
  }
  return [...matches];
}

/** Stable lanes with explicit parent edges; holes stay open until reused by another branch. */
export function graphRows(entries, head) {
  let lanes = [], nextColor = 0, width = 1;
  const rows = [];
  const vacant = () => { const hole = lanes.findIndex(lane => !lane); return hole < 0 ? lanes.length : hole; };
  for (const commit of entries) {
    const before = lanes.slice();
    let lane = lanes.findIndex(value => value?.sha === commit.sha);
    if (lane < 0) { lane = vacant(); lanes[lane] = { sha: commit.sha, color: nextColor++ }; }
    const color = lanes[lane].color, edges = [];
    before.forEach((value, index) => { if (value) edges.push({ from: index, to: index, color: value.color, half: 'top' }); });
    lanes[lane] = null;
    commit.parents.forEach((sha, index) => {
      let target = lanes.findIndex(value => value?.sha === sha);
      if (target < 0) {
        target = index === 0 && !lanes[lane] ? lane : vacant();
        lanes[target] = { sha, color: index === 0 ? color : nextColor++ };
      }
      edges.push({ from: lane, to: target, color: index === 0 ? color : lanes[target].color, half: 'bottom' });
    });
    before.forEach((value, index) => {
      if (value && index !== lane) edges.push({ from: index, to: index, color: value.color, half: 'bottom' });
    });
    width = Math.max(width, lane + 1, lanes.length);
    while (lanes.length && !lanes.at(-1)) lanes.pop();
    rows.push({ lane, color, edges, head: commit.sha === head, merge: commit.parents.length > 1 });
  }
  return { rows, width };
}
