/** Fixed, unprivileged Linux collector. Never reads command arguments or environment. */
export const OBSERVE_COMMAND = "python3 -";
export const OBSERVE_SCRIPT = String.raw`import json, os, subprocess, time

errors = []
def run(args, limit=300):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=4, check=True).stdout.splitlines()[:limit]
    except (OSError, subprocess.SubprocessError) as e:
        errors.append(args[0] + ': unavailable')
        return []

def cpu():
    with open('/proc/stat') as f: values = [int(x) for x in f.readline().split()[1:]]
    return sum(values), values[3] + values[4]

def memory():
    values = {}
    with open('/proc/meminfo') as f:
        for line in f:
            name, rest = line.split(':', 1)
            if name in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
                values[name] = int(rest.strip().split()[0]) * 1024
    return values

try:
    a = cpu(); time.sleep(0.25); b = cpu()
    total = b[0] - a[0]
    cpu_percent = round(100 * (1 - (b[1] - a[1]) / total), 1) if total > 0 else None
except (OSError, ValueError, IndexError, ZeroDivisionError):
    cpu_percent = None; errors.append('cpu: unavailable')
try: mem = memory()
except (OSError, ValueError): mem = {}; errors.append('memory: unavailable')
try:
    with open('/proc/uptime') as f: uptime = int(float(f.read().split()[0]))
    load = list(os.getloadavg())
except (OSError, ValueError): uptime = None; load = []; errors.append('uptime: unavailable')

disks = []
for line in run(['df', '-B1', '-P', '-T'], 80)[1:]:
    fields = line.split()
    if len(fields) >= 7 and fields[1] not in ('tmpfs', 'devtmpfs', 'squashfs', 'overlay'):
        try: disks.append({'filesystem': fields[0][:120], 'mount': fields[6][:120], 'totalBytes': int(fields[2]), 'usedBytes': int(fields[3])})
        except ValueError: pass

processes = []
for line in run(['ps', '-eo', 'pid=,user:24=,%cpu=,rss=,comm=','--sort=-%cpu'], 61):
    fields = line.strip().split(None, 4)
    if len(fields) == 5:
        try: processes.append({'pid': int(fields[0]), 'user': fields[1][:24], 'cpuPercent': float(fields[2]), 'rssBytes': int(fields[3])*1024, 'name': os.path.basename(fields[4])[:100]})
        except ValueError: pass

services = []
for line in run(['systemctl', 'list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager'], 251):
    fields = line.strip().lstrip('● ').split(None, 4)
    if len(fields) >= 4 and fields[0].endswith('.service'):
        services.append({'unit': fields[0][:160], 'load': fields[1], 'active': fields[2], 'sub': fields[3], 'description': fields[4][:160] if len(fields)>4 else ''})

ports = []
for line in run(['ss', '-ltnH'], 151):
    fields = line.split()
    if len(fields) >= 4: ports.append({'local': fields[3][:120]})

users = []
for line in run(['who'], 51):
    fields = line.split()
    if len(fields) >= 2: users.append({'user': fields[0][:32], 'terminal': fields[1][:32], 'since': ' '.join(fields[2:4])[:40]})

print(json.dumps({'observedAt': int(time.time()*1000), 'hostname': os.uname().nodename, 'cpuPercent': cpu_percent, 'cores': os.cpu_count(), 'load': load, 'uptimeSeconds': uptime, 'memoryTotalBytes': mem.get('MemTotal'), 'memoryUsedBytes': mem.get('MemTotal',0)-mem.get('MemAvailable',0) if 'MemAvailable' in mem else None, 'swapTotalBytes': mem.get('SwapTotal'), 'swapUsedBytes': mem.get('SwapTotal',0)-mem.get('SwapFree',0) if 'SwapFree' in mem else None, 'disks': disks, 'processes': processes, 'services': services, 'ports': ports, 'users': users, 'errors': errors}, separators=(',', ':')))
`;
