// Windows Script Host: find this installation's Node services and their children.
// Never emit process command lines, which can contain private data.
function resetWriterPids(rows, root, ownPid) {
  function contains(values, value) { for (var n = 0; n < values.length; n++) if (values[n] === value) return true; return false; }
  var prefix = String(root).replace(/\\/g, '/').toLowerCase() + '/mods/herdr-zed';
  var result = [], all = [], iterator = new Enumerator(rows);
  for (; !iterator.atEnd(); iterator.moveNext()) {
    var row = iterator.item(), pid = Number(row.ProcessId);
    all.push(row);
    var command = String(row.CommandLine || '').replace(/\\/g, '/').toLowerCase();
    var offset = command.indexOf(prefix);
    if (pid !== ownPid && String(row.Name).toLowerCase() === 'node.exe' && offset >= 0 &&
        (offset === 0 || /["\s]/.test(command.charAt(offset - 1))) &&
        /^(?:\/|-[a-z0-9-]+\/)/.test(command.slice(offset + prefix.length))) result.push(pid);
  }
  // Append descendants after parents; reverse this order when terminating.
  for (var changed = true; changed;) {
    changed = false;
    for (var i = 0; i < all.length; i++) {
      var child = Number(all[i].ProcessId);
      if (child !== ownPid && !contains(result, child) && contains(result, Number(all[i].ParentProcessId))) {
        result.push(child); changed = true;
      }
    }
  }
  return result;
}
function stopResetWriter(connection, row) {
  var pid = Number(row.ProcessId), failure;
  try {
    var code = Number(row.Terminate());
    if (code === 0) return;
    failure = 'return code ' + code;
  } catch (error) { failure = 'WMI error ' + Number(error.number || 0); }
  // A reader can exit between discovery and termination. A reused PID is no
  // longer the inspected process either; never terminate its replacement.
  var current = new Enumerator(connection.ExecQuery('SELECT ProcessId, CreationDate FROM Win32_Process WHERE ProcessId = ' + pid));
  if (current.atEnd()) return;
  if (row.CreationDate && current.item().CreationDate && String(row.CreationDate) !== String(current.item().CreationDate)) return;
  throw new Error('Could not stop Herdr Zed background process PID ' + pid + ': ' + failure + '.');
}
if (typeof WScript !== 'undefined') {
  try {
    var root = String(WScript.Arguments.Item(0)), ownPid = Number(WScript.Arguments.Item(1));
    if (!root || !(ownPid > 0)) throw new Error('Invalid process query');
    var connection = new ActiveXObject('WbemScripting.SWbemLocator').ConnectServer('.', 'root\\cimv2');
    var rows = connection.ExecQuery('SELECT * FROM Win32_Process');
    var pids = resetWriterPids(rows, root, ownPid);
    if (WScript.Arguments.length > 2 && String(WScript.Arguments.Item(2)) === 'stop') {
      for (var i = pids.length - 1; i >= 0; i--) {
        // Terminate the inspected WMI object, never a shell command assembled from argv.
        var iterator = new Enumerator(rows);
        for (; !iterator.atEnd(); iterator.moveNext()) {
          var row = iterator.item();
          if (Number(row.ProcessId) === pids[i]) stopResetWriter(connection, row);
        }
      }
    }
    WScript.Echo('[' + pids.join(',') + ']');
  } catch (error) {
    // Only our own diagnostic includes a message; arbitrary COM messages may
    // include private process details. Preserve the numeric WMI error instead.
    WScript.StdErr.WriteLine(/^Could not stop Herdr Zed background process PID \d+:/.test(error.message || '')
      ? error.message : 'Could not inspect Herdr Zed background processes (WMI error ' + Number(error.number || 0) + ').');
    WScript.Quit(1);
  }
}
