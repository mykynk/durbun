// /api/android/wireless of the dev mock (pair an Android phone over Wi-Fi), same shapes as the server
// (AdbWirelessState / AdbWirelessResult; checked by src/features/device/wireless/wireless.test.ts).
// Pairing code 123456 works; 000000 is a wrong code; an address starting with 10. cannot be reached; a host of
// 192.168.1.77 pairs but advertises no connect service (the dialog then asks for the connection address).

const SERVICES = [
  { name: 'adb-R58N91XYZ-Qw3rTy', kind: 'pairing', host: '192.168.1.42', port: 37115, serial: 'R58N91XYZ' },
  { name: 'adb-RF8N30ABCD-x7Kp2a', kind: 'connect', host: '192.168.1.31', port: 39573, serial: 'RF8N30ABCD', connected: true },
];

export function createMockWireless({ onConnected } = {}) {
  let paired = new Set();
  // The pairing screen stays listed (a dev mock is reloaded many times; the real phone closes it after pairing).
  const state = () => ({ adb: true, discovery: 'ok', services: SERVICES });

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      return null;
    }
  }
  const addr = (host, port) => (String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`);
  const badParam = (res, param, expected) => json(res, 400, { error: `${param} is not valid`, code: 'action.invalidParams', params: { param, expected } });

  async function pair(b) {
    await new Promise((r) => setTimeout(r, 1200));
    const address = addr(b.host, b.port);
    if (String(b.host).startsWith('10.')) return { ok: false, code: 'adb.wireless.unreachable', message: 'The phone could not be reached at this address', address };
    if (String(b.code).replace(/[\s-]/g, '') !== '123456') return { ok: false, code: 'adb.wireless.wrongCode', message: 'Wrong pairing code, or the connection dropped', address };
    paired.add(b.host);
    const out = { ok: true, code: 'adb.wireless.paired', message: `Paired with ${address}`, address };
    if (b.host === '192.168.1.77') return out;
    const connectAddress = addr(b.host, 41235);
    onConnected?.(b.host);
    return { ...out, serial: connectAddress, connected: { ok: true, address: connectAddress, code: 'adb.wireless.connected', message: `Connected to ${connectAddress}` } };
  }

  async function connect(b) {
    await new Promise((r) => setTimeout(r, 700));
    const address = addr(b.host, b.port);
    if (String(b.host).startsWith('10.')) return { ok: false, code: 'adb.wireless.unreachable', message: 'The phone could not be reached at this address', address };
    if (!paired.has(b.host) && !SERVICES.some((s) => s.kind === 'connect' && s.host === b.host)) return { ok: false, code: 'adb.wireless.notPaired', message: 'The phone does not know this Mac yet: pair it first', address };
    onConnected?.(b.host);
    return { ok: true, code: 'adb.wireless.connected', message: `Connected to ${address}`, address, serial: address };
  }

  /** true when it answered the request. */
  async function handle(req, res, p) {
    if (!p.startsWith('/api/android/wireless')) return false;
    if (p === '/api/android/wireless') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed', code: 'method.notAllowed' }), true;
      return json(res, 200, state()), true;
    }
    const op = p.slice('/api/android/wireless/'.length);
    if (op !== 'pair' && op !== 'connect') return json(res, 404, { error: 'Not found', code: 'api.notFound' }), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed', code: 'method.notAllowed' }), true;
    const b = await body(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'A JSON object is required', code: 'body.invalidJson' }), true;
    if (typeof b.host !== 'string' || !/^[A-Za-z0-9.:[\]-]+$/.test(b.host) || b.host.startsWith('-')) return badParam(res, 'host', 'host'), true;
    const port = Number(b.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return badParam(res, 'port', 'port'), true;
    if (op === 'pair' && !/^\d{6}$/.test(String(b.code ?? '').replace(/[\s-]/g, ''))) return badParam(res, 'code', 'pairingCode'), true;
    const host = b.host.replace(/^\[(.*)\]$/, '$1');
    json(res, 200, op === 'pair' ? await pair({ ...b, host, port }) : await connect({ host, port }));
    return true;
  }

  return { handle, state, reset: () => (paired = new Set()) };
}
