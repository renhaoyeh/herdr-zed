// CPU identifiers come from the OS. Counts alone do not establish P/E ordering.
export function macTopology(sysctl, tree, count) {
  const number = key => Number(new RegExp(`^${key.replaceAll('.', '\\.')}:[ \\t]+(\\d+)`, 'm').exec(sysctl || '')?.[1]) || null;
  const mapping = new Map();
  for (const block of (tree || '').split(/(?=^\s*[| ]*\+-o cpu\d+@)/m)) {
    const index = Number(/"logical-cpu-id" = (\d+)/.exec(block)?.[1]);
    const type = /"cluster-type" = <"([PE])">/.exec(block)?.[1] || null;
    if (Number.isInteger(index) && index >= 0 && index < count) mapping.set(index, type);
  }
  return { physical: number('hw.physicalcpu'), logical: count, sockets: number('hw.packages'),
    processors: Array.from({ length: count }, (_, index) => ({ index, id: `cpu:${index}`, group: 0,
      logical: index, physical: mapping.has(index) ? index : null, type: mapping.get(index) || null })) };
}

export function windowsTopology(sets, identifiers, metadata = {}) {
  const byId = new Map((sets || []).map(row => [`${row.group}:${row.logical}`, row]));
  const classes = [...new Set((sets || []).map(row => row.efficiency).filter(Number.isFinite))];
  const highest = Math.max(...classes);
  const processors = identifiers.map((id, index) => {
    const match = /^(\d+),(\d+)$/.exec(id), group = match ? Number(match[1]) : null, logical = match ? Number(match[2]) : index;
    const row = byId.get(`${group}:${logical}`);
    return { index, id, group, logical, physical: row?.core ?? null, efficiency: row?.efficiency ?? null,
      type: classes.length > 1 && row ? row.efficiency === highest ? 'P' : 'E' : null };
  });
  const known = processors.filter(cpu => cpu.physical !== null);
  return { physical: (known.length === processors.length && known.length
    ? new Set(known.map(cpu => `${cpu.group}:${cpu.physical}`)).size : null) || Number(metadata.physical) || null,
    logical: processors.length, sockets: Number(metadata.sockets) || null, processors };
}

export function processorLabel(cpu, index = 0) {
  return `CPU ${cpu?.logical ?? index}${cpu?.group ? ` · Group ${cpu.group}` : ''}${cpu?.type ? ` · ${cpu.type}` : ''}`;
}

export function topologyGroups(topology, selected) {
  const processors = (topology?.processors || []).filter(cpu => !selected || selected.includes(cpu.index));
  return ['P', 'E', null].flatMap(type => {
    const list = processors.filter(cpu => cpu.type === type);
    return list.length ? [{ type, name: type === 'P' ? 'Performance cores' : type === 'E' ? 'Efficiency cores' : 'Logical processors', processors: list }] : [];
  });
}

export function topologyLabel(topology, count) {
  if (!topology) return `${count || '—'} logical processors`;
  const groups = topologyGroups(topology);
  const types = groups.filter(group => group.type).map(group => `${new Set(group.processors.map(cpu => `${cpu.group}:${cpu.physical}`)).size}${group.type}`).join(' + ');
  return `${topology.physical || '—'} cores · ${topology.logical} logical processors${types ? ` · ${types}` : ''}`;
}
