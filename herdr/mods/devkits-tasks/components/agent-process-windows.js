// Shared: edit mods/devkits/components/agent-process-windows.js, then npm run sync:shared.
// Windows Script Host JScript: read-only WMI process metadata, no compiled helper.
// https://learn.microsoft.com/windows/win32/wmisdk/swbemlocator
function processDate(value) {
  var text = String(value || '');
  if (!/^\d{14}\.\d{6}[+-]\d{3}$/.test(text)) return null;
  var time = Date.UTC(Number(text.substr(0, 4)), Number(text.substr(4, 2)) - 1, Number(text.substr(6, 2)),
    Number(text.substr(8, 2)), Number(text.substr(10, 2)), Number(text.substr(12, 2)), Number(text.substr(15, 3)));
  return time - (text.charAt(21) === '+' ? 1 : -1) * Number(text.substr(22, 3)) * 60000;
}

function taskProviderProcesses(rows, root, kind) {
  var all = [], byId = {}, iterator = new Enumerator(rows);
  for (; !iterator.atEnd(); iterator.moveNext()) {
    var row = iterator.item();
    var item = { pid: Number(row.ProcessId), parent: Number(row.ParentProcessId), name: String(row.Name).toLowerCase(), createdAt: processDate(row.CreationDate) };
    all.push(item); byId[item.pid] = item;
  }
  var frontier = [root], visited = {};
  for (var depth = 0; depth < 32 && frontier.length; depth++) {
    var found = [], parents = {};
    for (var i = 0; i < frontier.length; i++) {
      var current = byId[frontier[i]];
      if (!current) continue;
      visited[current.pid] = true; parents[current.pid] = current;
      if (current.createdAt !== null && (kind === 'codex' ? current.name === 'codex.exe' : /^(claude|node)\.exe$/.test(current.name))) found.push(current);
    }
    if (found.length) return found;
    frontier = [];
    for (var j = 0; j < all.length; j++) {
      var child = all[j], parent = parents[child.parent];
      if (parent && !visited[child.pid] && parent.createdAt !== null && child.createdAt !== null && child.createdAt >= parent.createdAt) frontier.push(child.pid);
    }
  }
  return [];
}

if (typeof WScript !== 'undefined') {
  try {
    var root = Number(WScript.Arguments.Item(0)), kind = String(WScript.Arguments.Item(1));
    if (!(root > 0 && root === Math.floor(root)) || !/^(codex|claude)$/.test(kind)) throw new Error('Invalid process query');
    var connection = new ActiveXObject('WbemScripting.SWbemLocator').ConnectServer('.', 'root\\cimv2');
    var rows = connection.ExecQuery('SELECT ProcessId, ParentProcessId, Name, CreationDate FROM Win32_Process');
    var providers = taskProviderProcesses(rows, root, kind), json = [];
    for (var index = 0; index < providers.length; index++) json.push('{"pid":' + providers[index].pid + ',"createdAt":' + providers[index].createdAt + '}');
    WScript.Echo('{"processes":[' + json.join(',') + ']}');
  } catch (error) { WScript.Echo('{"processes":[]}'); WScript.Quit(1); }
}
