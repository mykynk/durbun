/* eslint-disable */
// Fake `adb` for android-phase3Driver.test.ts. State lives in $DURBUN_FAKE_ADB_DIR/state.json; every
// invocation is appended to calls.txt. `adb shell '<a>; <b>; …'` is answered part by part, like the
// device's sh would. Device clock = UTC.
const fs = require('fs');
const path = require('path');

const dir = process.env.DURBUN_FAKE_ADB_DIR;
const FIX = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.txt'), JSON.stringify(args) + '\n');
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const out = (s) => process.stdout.write(s);
const fx = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const pad = (n, w = 2) => String(n).padStart(w, '0');
const utc = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const epoch = (ms) => `${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)}`;

if (args[0] === 'version') { out('Android Debug Bridge version 1.0.41\nVersion 37.0.0-fake\n'); process.exit(0); }
if (args[0] === 'start-server') process.exit(0);
if (args[0] === 'devices') {
  out('List of devices attached\n' + st.devices.map((d) => `${d.serial}\t${d.state} usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7`).join('\n') + '\n\n');
  process.exit(0);
}
if (args[0] !== '-s') process.exit(1);
const dev = st.devices.find((d) => d.serial === args[1]);
if (!dev) { process.stderr.write(`adb: device '${args[1]}' not found\n`); process.exit(1); }
const cmd = args[2];
const rest = args.slice(3);
if (cmd === 'get-state') { out(dev.state + '\n'); process.exit(0); }
if (cmd === 'reverse' || cmd === 'forward') process.exit(0);
if (cmd === 'logcat') {
  const c = st.crashMs;
  const line = (ms, pid, tid, lvl, tag, msg) => `${epoch(ms).padStart(20)} ${String(pid).padStart(5)} ${String(tid).padStart(5)} ${lvl} ${tag.padEnd(8)}: ${msg}\n`;
  out('--------- beginning of main\n');
  out(line(c - 5000, 612, 650, 'I', 'ActivityManager', 'Start proc 4321:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}'));
  out(line(c - 4000, 4321, 4321, 'I', 'flutter', 'Pati açıldı'));
  out('--------- beginning of crash\n');
  out(line(c, 4321, 4321, 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'));
  out(line(c, 4321, 4321, 'E', 'AndroidRuntime', 'Process: com.mykynk.pati, PID: 4321'));
  out(line(c, 4321, 4321, 'E', 'AndroidRuntime', 'java.lang.IllegalStateException: Boom'));
  out(line(c, 4321, 4321, 'E', 'AndroidRuntime', '\tat com.mykynk.pati.MainActivity.onCreate(MainActivity.kt:21)'));
  out(line(c + 120, 612, 700, 'I', 'ActivityManager', 'Process com.mykynk.pati (pid 4321) has died: fg  TOP'));
  out(line(c + 900, 612, 650, 'I', 'ActivityManager', 'Start proc 4500:com.mykynk.pati/u0a190 for next-top-activity {com.mykynk.pati/com.mykynk.pati.MainActivity}'));
  setInterval(() => {}, 1000);
  return;
}
if (cmd !== 'shell') process.exit(0);

// st.uninstalled: packages removed from the phone (gone from ps, pm list and dumpsys package).
const gone = new Set(st.uninstalled || []);
const installed = (line) => ![...gone].some((pkg) => line.endsWith(` ${pkg}`) || line.endsWith(`:${pkg}`));
const PS = '  PID NAME\n    1 init\n  612 system_server\n  900 com.google.android.gms\n  901 com.google.android.gms.persistent\n 4500 com.mykynk.pati\n 5100 com.mykynk.mahalle\n'
  .split('\n').filter(installed).join('\n');
const DUMPS = {
  'com.mykynk.pati': 'dumpsys-package-api34-debug-adb.txt',
  'com.mykynk.mahalle': 'dumpsys-package-api34-play.txt',
};
const BOX_HEAD = (tag) => `Drop box contents: 12 entries\nMax entries: 1000\nLow priority rate limit period: 2000 ms\nLow priority tags: {data_app_wtf, keymaster}\n\nSearching for: ${tag}\n\n`;

function latency() {
  // 60 Hz frames up to "now" on a fake CLOCK_MONOTONIC (ns, < 2^63, < 17 digits).
  const period = 16666666;
  const nowNs = (Date.now() - 1780000000000) * 1e6;
  const last = Math.floor(nowNs / period) * period;
  const rows = [];
  for (let k = 126; k >= 0; k--) {
    const p = last - k * period;
    rows.push(`${p - 2 * period}\t${p}\t${p - period}`);
  }
  return `${period}\n${rows.join('\n')}\n\n`;
}

function part(p) {
  if (p.startsWith('echo ')) return p.slice(5) + '\n';
  if (p === 'getprop') return ['[ro.build.version.release]: [14]', '[ro.build.version.sdk]: [34]', '[ro.product.manufacturer]: [Google]', '[ro.product.model]: [Pixel 6]'].join('\n') + '\n';
  if (p === 'getprop persist.sys.timezone') return 'Etc/UTC\n';
  if (p === 'date +%z') return '+0000\n';
  if (p === 'settings get global device_name') return 'Pixel 6\n';
  if (p === 'wm size') return 'Physical size: 1080x2400\n';
  if (p === 'wm density') return 'Physical density: 411\n';
  if (p === 'dumpsys battery') return '  level: 80\n  scale: 100\n  status: 2\n  USB powered: true\n';
  if (p.startsWith('ps')) return PS;
  if (p === 'pm list packages -3') return 'package:com.mykynk.pati\npackage:com.mykynk.mahalle\npackage:com.example.native\n'.split('\n').filter(installed).join('\n');
  if (p === 'pm list packages -s') return 'package:android\npackage:com.google.android.gms\npackage:com.android.systemui\n';
  if (p.startsWith('cmd package resolve-activity ')) {
    // "… <pkg> 2>/dev/null | grep -E 'packageName=|nonLocalizedLabel='", answered already filtered.
    const pkg = p.split(' 2>/dev/null')[0].split(' ').pop();
    if (pkg !== 'com.mykynk.pati') return '';
    return fx('resolve-activity-api34.txt').split('\n').filter((l) => /packageName=|nonLocalizedLabel=/.test(l)).join('\n') + '\n';
  }
  if (p.startsWith('dumpsys package ')) {
    const pkg = p.slice('dumpsys package '.length);
    return DUMPS[pkg] && !gone.has(pkg) ? fx(DUMPS[pkg]) : `Unable to find package: ${pkg}\n`;
  }
  const crashDate = utc(st.crashMs + 300);
  if (p.startsWith('dumpsys dropbox --print data_app_crash')) {
    return BOX_HEAD('data_app_crash') + '========================================\n' + `${crashDate} data_app_crash (text, 812 bytes)\n` +
      'Process: com.mykynk.pati\nPID: 4321\nUID: 10190\nFlags: 0x38c8be46\nPackage: com.mykynk.pati v1 (1.4.0-dev)\nForeground: Yes\nBuild: google/oriole/oriole:14/UQ1A.240205.004/11269751:user/release-keys\n\n' +
      'java.lang.IllegalStateException: Boom\n\tat com.mykynk.pati.MainActivity.onCreate(MainActivity.kt:21)\n\n';
  }
  if (p === 'dumpsys dropbox data_app_crash') {
    return BOX_HEAD('data_app_crash') + `${crashDate} data_app_crash (text, 812 bytes)\n    Process: com.mykynk.pati/PID: 4321/UID: 10190/Flags: 0x38c8be46/Packag ...\n`;
  }
  if (p.startsWith('dumpsys dropbox ')) return BOX_HEAD(p.split(' ').pop()) + '(No entries found.)\n';
  if (p.startsWith('pidof ')) return p === 'pidof com.mykynk.pati' ? '4500\n' : '';
  if (p.startsWith('cat /proc/4500/stat')) {
    const ticks = 1000 + Math.floor((Date.now() % 100000) / 10);
    return `4500 (mykynk.pati) S 612 612 0 0 -1 1077952832 92536 0 1 0 ${ticks} 412 0 0 10 -10 57 0 4021 1 1\nVmRSS:\t  204800 kB\nThreads:\t57\n`;
  }
  if (p.startsWith('dumpsys gfxinfo ')) return fx('gfxinfo-flutter-api34.txt');
  if (p === 'dumpsys SurfaceFlinger --list') return fx('sf-list-api34.txt');
  if (p.startsWith('dumpsys SurfaceFlinger --latency ')) return p.includes('(BLAST)#1422') ? latency() : '16666666\n';
  return '';
}

const command = rest.join(' ');
// "a && b" stays one part (only the /proc read uses it); "; " separates parts.
out(command.split('; ').map(part).join(''));
process.exit(0);
