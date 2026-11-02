// Smoke test of the BUILT package in plain Node (run `npm run build` first):
//  - package "exports": `import` → dist/index.js (ESM), `require` → dist/cjs/index.js (CommonJS);
//  - both copies loaded at once share ONE running client (no split logs);
//  - hello/welcome, logs, events, console capture and ignoring the desktop's own origin.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const received = [];
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/sdk' });
await new Promise((resolve) => wss.once('listening', resolve));
const port = wss.address().port;
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    received.push(msg);
    if (msg.type === 'hello') {
      ws.send(
        JSON.stringify({
          type: 'welcome',
          protocol: 1,
          server: 'durbun/smoke',
          appId: 'app:1',
          config: { captureBodies: true, maxBodyBytes: 1048576, metricsIntervalMs: 1000, deviceLogsAvailable: false },
          mocks: [],
        }),
      );
    }
  });
});

const esm = await import('@durbun/react-native');
const cjs = require('@durbun/react-native');
assert.match(import.meta.resolve('@durbun/react-native'), /\/dist\/index\.js$/);
assert.match(require.resolve('@durbun/react-native'), /\/dist\/cjs\/index\.js$/);
assert.notEqual(esm.Durbun, cjs.Durbun, 'expected two module copies (ESM + CJS)');
assert.equal(esm.SDK_VERSION, cjs.SDK_VERSION);

esm.Durbun.start({ host: '127.0.0.1', port, enabled: true, captureMetrics: false });
for (let i = 0; i < 150 && !cjs.Durbun.isConnected; i++) await new Promise((r) => setTimeout(r, 20));
assert.equal(cjs.Durbun.isConnected, true, 'the CommonJS copy sees the client started through ESM');
cjs.Durbun.start({ host: '127.0.0.1', port, enabled: true }); // second start: no-op

cjs.Durbun.info('from cjs', { data: { ok: true } });
esm.Durbun.event('from-esm', { n: 1 });
console.log('[smoke] console line');
await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined); // desktop origin: never captured
await new Promise((r) => setTimeout(r, 300));
esm.Durbun.stop();
assert.equal(cjs.Durbun.isStarted, false);

const types = received.map((m) => m.type);
assert.equal(types.filter((t) => t === 'hello').length, 1, 'exactly one session');
assert.ok(received.some((m) => m.type === 'log' && m.message === 'from cjs' && m.data.ok === true));
assert.ok(received.some((m) => m.type === 'event' && m.name === 'from-esm'));
// "[smoke] …" prefix becomes the tag chip.
assert.ok(received.some((m) => m.type === 'log' && m.tag === 'smoke' && m.message === 'console line'));
assert.equal(types.filter((t) => t === 'net.request').length, 0);
wss.close();
console.log(`smoke ok: ${received.length} messages (${[...new Set(types)].join(', ')})`);
