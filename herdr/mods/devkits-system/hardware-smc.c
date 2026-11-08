// Read-only Apple SMC reader. ABI/key references: exelban/Stats (MIT), see assets/licenses/stats.txt.
// The only SMC commands in this program are 9 (read key info) and 5 (read bytes).
#include <IOKit/IOKitLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <sys/sysctl.h>

typedef struct { uint8_t major, minor, build, reserved; uint16_t release; } Version;
typedef struct { uint16_t version, length; uint32_t cpu, gpu, memory; } Limits;
typedef struct { uint32_t size, type; uint8_t attributes; } KeyInfo;
typedef struct { uint32_t key; Version version; Limits limits; KeyInfo info;
    uint8_t result, status, command; uint32_t data; uint8_t bytes[32]; } SMCData;
_Static_assert(sizeof(SMCData) == 80, "SMC ABI size");

static uint32_t fourcc(const char *key) {
    return (uint32_t)(uint8_t)key[0]<<24 | (uint32_t)(uint8_t)key[1]<<16 | (uint32_t)(uint8_t)key[2]<<8 | (uint8_t)key[3];
}
static double decode(const SMCData *data) {
    const uint8_t *b = data->bytes;
    if (data->info.type == fourcc("flt ") && data->info.size == 4) { float value; memcpy(&value, b, 4); return value; }
    if (data->info.type == fourcc("sp78") && data->info.size == 2) return (int16_t)((b[0]<<8)|b[1]) / 256.0;
    if (data->info.type == fourcc("fpe2") && data->info.size == 2) return ((b[0]<<8)|b[1]) / 4.0;
    if (data->info.type == fourcc("ui8 ") && data->info.size == 1) return b[0];
    if (data->info.type == fourcc("ui16") && data->info.size == 2) return (b[0]<<8)|b[1];
    if (data->info.type == fourcc("ui32") && data->info.size == 4) return (uint32_t)b[0]<<24 | (uint32_t)b[1]<<16 | (uint32_t)b[2]<<8 | b[3];
    return NAN;
}
static double read_value(io_connect_t connection, const char *key) {
    SMCData input = {0}, output = {0}; size_t size = sizeof(output);
    input.key = fourcc(key); input.command = 9;
    if (IOConnectCallStructMethod(connection, 2, &input, sizeof(input), &output, &size) != KERN_SUCCESS || output.result) return NAN;
    if (!output.info.size || output.info.size > 32) return NAN;
    input.info = output.info; input.command = 5; size = sizeof(output);
    if (IOConnectCallStructMethod(connection, 2, &input, sizeof(input), &output, &size) != KERN_SUCCESS || output.result) return NAN;
    output.info = input.info;
    return decode(&output);
}
static int emitted;
static void emit(io_connect_t connection, const char *key, const char *name, const char *type, const char *unit, double minimum, double maximum) {
    double value = read_value(connection, key);
    if (!isfinite(value) || value < minimum || value > maximum) return;
    printf("%s{\"id\":\"smc:%s\",\"name\":\"%s\",\"type\":\"%s\",\"unit\":\"%s\",\"value\":%.3f,\"source\":\"Apple SMC\"}", emitted++ ? "," : "", key, name, type, unit, value);
}
static void temperatures(io_connect_t connection, const char **keys, size_t count, const char *group) {
    for (size_t i=0; i<count; i++) { char label[80]; snprintf(label, sizeof(label), "%s sensor %zu", group, i+1); emit(connection, keys[i], label, "Temperature", "°C", 1, 130); }
}
#define TEMPS(group, ...) do { const char *keys[] = {__VA_ARGS__}; temperatures(connection, keys, sizeof(keys)/sizeof(keys[0]), group); } while(0)

int main(void) {
    io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
    io_connect_t connection = 0;
    if (!service) { puts("[]"); return 0; }
    kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &connection); IOObjectRelease(service);
    if (result != KERN_SUCCESS) { puts("[]"); return 0; }
    char brand[160] = {0}; size_t length = sizeof(brand); sysctlbyname("machdep.cpu.brand_string", brand, &length, NULL, 0);
    printf("[");
    if (strstr(brand,"Apple M4")) {
        TEMPS("CPU efficiency", "Te05","Te0S","Te09","Te0H");
        TEMPS("CPU performance", "Tp01","Tp05","Tp09","Tp0D","Tp0V","Tp0Y","Tp0b","Tp0e");
        TEMPS("GPU", "Tg0G","Tg0H","Tg1U","Tg1k","Tg0K","Tg0L","Tg0d","Tg0e","Tg0j","Tg0k");
        TEMPS("Memory proximity", "Tm0p","Tm1p","Tm2p");
    } else if (strstr(brand,"Apple M3")) {
        TEMPS("CPU efficiency", "Te05","Te0L","Te0P","Te0S");
        TEMPS("CPU performance", "Tf04","Tf09","Tf0A","Tf0B","Tf0D","Tf0E","Tf44","Tf49","Tf4A","Tf4B","Tf4D","Tf4E");
        TEMPS("GPU", "Tf14","Tf18","Tf19","Tf1A","Tf24","Tf28","Tf29","Tf2A");
    } else if (strstr(brand,"Apple M2")) {
        TEMPS("CPU efficiency", "Tp1h","Tp1t","Tp1p","Tp1l");
        TEMPS("CPU performance", "Tp01","Tp05","Tp09","Tp0D","Tp0X","Tp0b","Tp0f","Tp0j");
        TEMPS("GPU", "Tg0f");
    } else if (strstr(brand,"Apple M1")) {
        TEMPS("CPU efficiency", "Tp09","Tp0T");
        TEMPS("CPU performance", "Tp01","Tp05","Tp0D","Tp0H","Tp0L","Tp0P","Tp0X","Tp0b");
        TEMPS("GPU", "Tg05");
    } else if (!strstr(brand,"Apple")) {
        TEMPS("CPU package", "TC0P","TC0D"); TEMPS("GPU", "TG0P","TG0D");
    }
    emit(connection,"TH0x","SSD NAND temperature","Temperature","°C",1,130);
    emit(connection,"PSTR","System power","Power","W",0,2000);
    emit(connection,"PCPC","CPU package power","Power","W",0,1000);
    emit(connection,"PG0C","GPU power","Power","W",0,1000);
    emit(connection,"PMTR","Memory power","Power","W",0,500);
    double fans = read_value(connection, "FNum");
    if (isfinite(fans) && fans>=0 && fans<=16) for(int i=0; i<(int)fans; i++) {
        char key[5], name[20]; snprintf(key,sizeof(key),"F%XAc",i); snprintf(name,sizeof(name),"Fan %d",i+1);
        emit(connection,key,name,"Fan","RPM",0,30000);
    }
    printf("]\n"); IOServiceClose(connection); return 0;
}
