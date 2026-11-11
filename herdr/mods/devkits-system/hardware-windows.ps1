param([switch]$Topology, [switch]$Sensors)
# Read-only CIM/performance queries. No affinity, power, fan or process setters.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Read-Cim($Class, $Properties, $Namespace = 'root/cimv2') {
    try { @(Get-CimInstance -Namespace $Namespace -ClassName $Class -Property $Properties -ErrorAction Stop) }
    catch { @() }
}
$result = @{}
$result.cpu = @(Read-Cim 'Win32_PerfRawData_Counters_ProcessorInformation' @('Name','PercentIdleTime','Timestamp_Sys100NS') | Where-Object { $_.Name -match '^\d+,\d+$' } | ForEach-Object {
    @{ id = $_.Name; idle = [string]$_.PercentIdleTime; time = [string]$_.Timestamp_Sys100NS }
})
$result.disks = @(Read-Cim 'Win32_PerfRawData_PerfDisk_PhysicalDisk' @('Name','DiskReadBytesPersec','DiskWriteBytesPersec','Timestamp_PerfTime','Frequency_PerfTime') | Where-Object { $_.Name -ne '_Total' } | ForEach-Object {
    @{ id = $_.Name; read = [string]$_.DiskReadBytesPersec; write = [string]$_.DiskWriteBytesPersec;
       at = if ($_.Frequency_PerfTime) { [double]$_.Timestamp_PerfTime / [double]$_.Frequency_PerfTime } else { $null } }
})
$result.gpuEngines = @(Read-Cim 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine' @('Name','UtilizationPercentage') | ForEach-Object {
    @{ id = $_.Name; percent = [double]$_.UtilizationPercentage }
})
$result.gpuMemory = @(Read-Cim 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory' @('Name','DedicatedUsage','SharedUsage') | ForEach-Object {
    @{ id = $_.Name; dedicatedUsed = [double]$_.DedicatedUsage; sharedUsed = [double]$_.SharedUsage }
})
if ($Topology) {
    $result.metadata = @{}
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DevkitsCpuSet {
    public int group, logical, core, efficiency;
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint required, IntPtr process, uint flags);
    public static DevkitsCpuSet[] Read() {
        uint size;
        GetSystemCpuSetInformation(IntPtr.Zero, 0, out size, IntPtr.Zero, 0);
        if (size == 0 || size > 4194304) return new DevkitsCpuSet[0];
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try {
            uint returned;
            if (!GetSystemCpuSetInformation(buffer, size, out returned, IntPtr.Zero, 0)) return new DevkitsCpuSet[0];
            var result = new List<DevkitsCpuSet>();
            for (int offset = 0; offset + 32 <= returned; ) {
                IntPtr item = IntPtr.Add(buffer, offset);
                int length = Marshal.ReadInt32(item);
                if (length < 32 || (long)offset + length > returned) break;
                if (Marshal.ReadInt32(item, 4) == 0) result.Add(new DevkitsCpuSet {
                    group = (ushort)Marshal.ReadInt16(item, 12), logical = Marshal.ReadByte(item, 14),
                    core = Marshal.ReadByte(item, 15), efficiency = Marshal.ReadByte(item, 18)
                });
                offset += length;
            }
            return result.ToArray();
        } finally { Marshal.FreeHGlobal(buffer); }
    }
}
// DXGI uses pointer-sized capacities; Win32_VideoController.AdapterRAM truncates cards above 4 GB.
public class DevkitsGpuAdapter {
    public string id, name;
    public ulong dedicated, shared;
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Description {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string name;
        public uint vendor, device, subsystem, revision;
        public UIntPtr dedicated, system, shared;
        public Luid luid;
        public uint flags;
    }
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Enumerate(IntPtr self, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Describe(IntPtr self, out Description description);
    public static DevkitsGpuAdapter[] Read() {
        var result = new List<DevkitsGpuAdapter>();
        var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory;
        if (CreateDXGIFactory1(ref iid, out factory) < 0 || factory == IntPtr.Zero) return result.ToArray();
        try {
            var enumerate = (Enumerate)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory), 12 * IntPtr.Size), typeof(Enumerate));
            for (uint index = 0; index < 64; index++) {
                IntPtr adapter;
                if (enumerate(factory, index, out adapter) < 0 || adapter == IntPtr.Zero) break;
                try {
                    var describe = (Describe)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter), 10 * IntPtr.Size), typeof(Describe));
                    Description d;
                    if (describe(adapter, out d) >= 0 && (d.flags & 2) == 0) result.Add(new DevkitsGpuAdapter {
                        id = String.Format("luid_0x{0:x8}_0x{1:x8}_phys_0", unchecked((uint)d.luid.high), d.luid.low),
                        name = d.name, dedicated = d.dedicated.ToUInt64(), shared = d.shared.ToUInt64()
                    });
                } finally { Marshal.Release(adapter); }
            }
        } finally { Marshal.Release(factory); }
        return result.ToArray();
    }
}
'@
        $result.cpuSets = @([DevkitsCpuSet]::Read())
    } catch { $result.cpuSets = @() }
    try { $result.metadata.gpuAdapters = @([DevkitsGpuAdapter]::Read()) } catch { $result.metadata.gpuAdapters = @() }
}
if ($Sensors) {
    # Optional existing LibreHardwareMonitor provider; do not install/start it or its driver.
    $result.sensors = @(Read-Cim 'Sensor' @('Identifier','Name','SensorType','Value','Parent') 'root/LibreHardwareMonitor' | Where-Object { $_.SensorType -in @('Temperature','Fan','Power') } | ForEach-Object {
        @{ id = $_.Identifier; name = $_.Name; type = $_.SensorType; value = $_.Value; parent = $_.Parent; source = 'LibreHardwareMonitor' }
    })
}
$result | ConvertTo-Json -Depth 8 -Compress
