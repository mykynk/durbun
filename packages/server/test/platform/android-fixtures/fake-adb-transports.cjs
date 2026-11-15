/* eslint-disable */
// Fake `adb` for android-transports.test.ts: one phone on several transports (USB serial + Wi-Fi ip:port
// sharing one ro.serialno), a configurable client version and the "killing..." line a real adb prints when
// it restarts a server of another version. State: $DURBUN_FAKE_ADB_DIR/state.json; calls → calls.txt as
// [binary label, ...args].
const fs = require('fs');
const path = require('path');

const dir = process.env.DURBUN_FAKE_ADB_DIR;
const label = process.env.DURBUN_FAKE_ADB_LABEL || 'adb';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.txt'), JSON.stringify([label, ...args]) + '\n');
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const version = Number(process.env.DURBUN_FAKE_ADB_VERSION || st.version || 41);
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

if (args[0] === 'version') {
  out(`Android Debug Bridge version 1.0.${version}\nVersion 35.0.2-fake\nInstalled as /fake/${label}\nRunning on Darwin 25.0.0 (arm64)\n`);
  process.exit(0);
}
// A real client finding another server version: one stderr line, kills it, starts its own.
if (st.killServerVersion) err(`adb server version (${st.killServerVersion}) doesn't match this client (${version}); killing...\n* daemon started successfully\n`);
if (args[0] === 'start-server') process.exit(0);
if (args[0] === 'devices') {
  out('List of devices attached\n' + st.devices.map((d) => {
    const usb = !/[:.]/.test(d.serial);
    const props = d.state === 'device' ? ` ${usb ? 'usb:1-1 ' : ''}product:a73xqxx model:SM_A736B device:a73xq transport_id:${d.tid || 3}` : ` transport_id:${d.tid || 3}`;
    return `${d.serial}\t${d.state}${props}`;
  }).join('\n') + '\n\n');
  process.exit(0);
}
if (args[0] !== '-s') process.exit(1);
const dev = st.devices.find((d) => d.serial === args[1]);
if (!dev) { err(`adb: device '${args[1]}' not found\n`); process.exit(1); }
const cmd = args[2];
const rest = args.slice(3);
if (cmd === 'get-state') { out(dev.state + '\n'); process.exit(0); }
if (cmd === 'reverse') { if (rest[0] === '--list') out(''); process.exit(0); }
if (cmd === 'forward') { if (rest[0] === 'tcp:0') out('45678\n'); process.exit(0); }
if (cmd === 'logcat') {
  if (rest.includes('-c')) process.exit(0);
  if (rest.includes('-d')) { out((st.dump || []).join('\n') + '\n'); process.exit(0); }
  setInterval(() => {}, 1000);
  return;
}
if (cmd !== 'shell') process.exit(0);
const part = (p) => {
  if (p.startsWith('echo ')) return p.slice(5) + '\n';
  if (p === 'getprop ro.serialno') return (dev.hw || '') + '\n';
  if (p === 'getprop') return ['[ro.build.version.release]: [14]', '[ro.build.version.sdk]: [34]', '[ro.product.manufacturer]: [samsung]', '[ro.product.model]: [SM-A736B]', '[ro.product.marketname]: [Galaxy A73 5G]', `[ro.serialno]: [${dev.hw || ''}]`].join('\n') + '\n';
  if (p === 'getprop persist.sys.timezone') return 'Etc/UTC\n';
  if (p === 'date +%z') return '+0000\n';
  if (p === 'settings get global device_name') return 'Galaxy A73\n';
  if (p === 'wm size') return 'Physical size: 1080x2400\n';
  if (p === 'wm density') return 'Physical density: 420\n';
  if (p === 'dumpsys battery') return '  level: 64\n  scale: 100\n  status: 2\n  USB powered: true\n';
  if (p.startsWith('ps')) return '  PID NAME\n    1 init\n  612 system_server\n 4500 com.mykynk.pati\n';
  if (p === 'pm list packages -3') return 'package:com.mykynk.pati\n';
  if (p === 'pm list packages -s') return 'package:android\npackage:com.android.systemui\n';
  if (p.startsWith('dumpsys dropbox ')) return `Drop box contents: 0 entries\n\nSearching for: ${p.split(' ').pop()}\n\n(No entries found.)\n`;
  return '';
};
out(rest.join(' ').split('; ').map(part).join(''));
process.exit(0);
