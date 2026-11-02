import { describe, expect, it } from 'vitest';
import {
  extractVmServiceUrl,
  isLoopbackHost,
  normalizeVmServiceUrl,
  parseVmServiceAnnouncement,
  redactServiceUrl,
  toHttpBase,
  withHostPort,
  wsUrlFromRedirect,
} from '../../src/platform/flutterVm/url';

describe('normalizeVmServiceUrl', () => {
  it.each([
    ['http://127.0.0.1:57423/xGm5ma3sRbA=/', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['http://127.0.0.1:57423/xGm5ma3sRbA=', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['ws://127.0.0.1:57423/xGm5ma3sRbA=/ws', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['ws://127.0.0.1:57423/xGm5ma3sRbA=/ws/', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['ws://127.0.0.1:57423/xGm5ma3sRbA=', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['https://vm.example:8443/tok=/', 'wss://vm.example:8443/tok=/ws'],
    ['http://127.0.0.1:8181/', 'ws://127.0.0.1:8181/ws'],
    ['http://[::1]:8181/abc12=/', 'ws://[::1]:8181/abc12=/ws'],
    ['http://127.0.0.1:8181/abc12=/?foo=1#frag', 'ws://127.0.0.1:8181/abc12=/ws'],
    [
      'http://127.0.0.1:49364/Jrn077vmJB8=/devtools/?uri=ws://127.0.0.1:49364/Jrn077vmJB8=/ws',
      'ws://127.0.0.1:49364/Jrn077vmJB8=/ws',
    ],
  ])('%s → %s', (input, expected) => {
    expect(normalizeVmServiceUrl(input)).toBe(expected);
  });

  it('rejects other schemes and garbage', () => {
    expect(() => normalizeVmServiceUrl('ftp://127.0.0.1:21/x=/')).toThrow(/scheme/);
    expect(() => normalizeVmServiceUrl('not a url')).toThrow(/valid/);
  });
});

describe('extractVmServiceUrl', () => {
  it('finds the VM service in a pasted `flutter run` block (ignoring docs links and the DevTools line order)', () => {
    const block = `Launching lib/main.dart on sdk gphone64 arm64 in debug mode...
Warning: see https://docs.gradle.org/8.7/userguide/command_line_interface.html#sec:command_line_warnings
Running Gradle task 'assembleDebug'...                             12.3s
✓ Built build/app/outputs/flutter-apk/app-debug.apk
Syncing files to device sdk gphone64 arm64...                       98ms

Flutter run key commands.
r Hot reload. 🔥🔥🔥
R Hot restart.

A Dart VM Service on sdk gphone64 arm64 is available at: http://127.0.0.1:57423/xGm5ma3sRbA=/
The Flutter DevTools debugger and profiler on sdk gphone64 arm64 is available at: http://127.0.0.1:9101?uri=http://127.0.0.1:57423/xGm5ma3sRbA=/
`;
    expect(extractVmServiceUrl(block)).toBe('ws://127.0.0.1:57423/xGm5ma3sRbA=/ws');
  });

  it('prefers the VM service line over an earlier DevTools line', () => {
    const block = `The Flutter DevTools debugger and profiler on iPhone 16 is available at: http://127.0.0.1:9100?uri=http://127.0.0.1:61234/kKbQcJ1VYZ4=/
A Dart VM Service on iPhone 16 is available at: http://127.0.0.1:61234/kKbQcJ1VYZ4=/`;
    expect(extractVmServiceUrl(block)).toBe('ws://127.0.0.1:61234/kKbQcJ1VYZ4=/ws');
  });

  it('handles `dart run --observe` output', () => {
    const out = `The Dart VM service is listening on http://127.0.0.1:49364/Jrn077vmJB8=/
The Dart DevTools debugger and profiler is available at: http://127.0.0.1:49364/Jrn077vmJB8=/devtools/?uri=ws://127.0.0.1:49364/Jrn077vmJB8=/ws`;
    expect(extractVmServiceUrl(out)).toBe('ws://127.0.0.1:49364/Jrn077vmJB8=/ws');
  });

  it.each([
    ['http://127.0.0.1:9101?uri=http://127.0.0.1:57423/xGm5ma3sRbA=/', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['http://127.0.0.1:9101/?uri=ws%3A%2F%2F127.0.0.1%3A8181%2Fabc12%3D%2Fws', 'ws://127.0.0.1:8181/abc12=/ws'],
    ['http://127.0.0.1:9100/#/?uri=ws%3A%2F%2F127.0.0.1%3A8181%2Fabc12%3D%2Fws', 'ws://127.0.0.1:8181/abc12=/ws'],
    ['  ws://127.0.0.1:57423/xGm5ma3sRbA=/ws  ', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['127.0.0.1:57423/xGm5ma3sRbA=/', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['"http://127.0.0.1:57423/xGm5ma3sRbA=/".', 'ws://127.0.0.1:57423/xGm5ma3sRbA=/ws'],
    ['(see http://[::1]:8181/abc12=/)', 'ws://[::1]:8181/abc12=/ws'],
    [
      '2020-09-15 13:42:25.185474-0700 Runner[477:181141] flutter: The Dart VM service is listening on http://127.0.0.1:57782/AbC_d-12=/',
      'ws://127.0.0.1:57782/AbC_d-12=/ws',
    ],
    ['Observatory listening on http://127.0.0.1:41935/Ab0-c_d1E2f=/', 'ws://127.0.0.1:41935/Ab0-c_d1E2f=/ws'],
  ])('%s', (input, expected) => {
    expect(extractVmServiceUrl(input)).toBe(expected);
  });

  it('returns undefined when there is nothing attachable', () => {
    expect(extractVmServiceUrl('')).toBeUndefined();
    expect(extractVmServiceUrl('no url here')).toBeUndefined();
    expect(extractVmServiceUrl('see https://docs.flutter.dev/x and https://pub.dev/y')).toBeUndefined();
    expect(extractVmServiceUrl('http://127.0.0.1:9101/devtools/')).toBeUndefined();
  });
});

describe('parseVmServiceAnnouncement', () => {
  it.each([
    ['The Dart VM service is listening on http://127.0.0.1:41935/Ab0-c_d1E2f=/', 'http://127.0.0.1:41935/Ab0-c_d1E2f=/'],
    ['flutter: The Dart VM service is listening on http://127.0.0.1:57782/AbC_d-12=/', 'http://127.0.0.1:57782/AbC_d-12=/'],
    ['(Flutter) The Dart VM service is listening on http://127.0.0.1:57701/', 'http://127.0.0.1:57701/'],
    ['Observatory listening on http://127.0.0.1:41935/Ab0-c_d1E2f=/', 'http://127.0.0.1:41935/Ab0-c_d1E2f=/'],
    ['The Dart VM service is listening on //127.0.0.1:41935/Ab0=/', 'http://127.0.0.1:41935/Ab0=/'],
    ['The Dart VM service is listening on http://[::1]:41935/Ab0=/.', 'http://[::1]:41935/Ab0=/'],
  ])('%s', (message, expected) => {
    expect(parseVmServiceAnnouncement(message)).toBe(expected);
  });

  it('ignores other lines', () => {
    expect(parseVmServiceAnnouncement('Server listening on http://0.0.0.0:8080')).toBeUndefined();
    expect(parseVmServiceAnnouncement('I/flutter: hello')).toBeUndefined();
    expect(parseVmServiceAnnouncement('')).toBeUndefined();
  });
});

describe('URL helpers', () => {
  it('toHttpBase gives the service root (safe to GET)', () => {
    expect(toHttpBase('ws://127.0.0.1:57423/xGm5ma3sRbA=/ws')).toBe('http://127.0.0.1:57423/xGm5ma3sRbA=/');
    expect(toHttpBase('wss://h:1/ws')).toBe('https://h:1/');
  });

  it('withHostPort swaps the address after a port forward', () => {
    expect(withHostPort('ws://127.0.0.1:41935/Ab0=/ws', '127.0.0.1', 61002)).toBe('ws://127.0.0.1:61002/Ab0=/ws');
    expect(withHostPort('ws://127.0.0.1:41935/Ab0=/ws', '::1', 61002)).toBe('ws://[::1]:61002/Ab0=/ws');
  });

  it('wsUrlFromRedirect understands both VM service redirects (verified against Dart 3.10 + DDS)', () => {
    // GET of the service root while DDS is active:
    expect(
      wsUrlFromRedirect(
        'http://127.0.0.1:49232/qbokSmrYPWk=/devtools/?uri=ws%3A%2F%2F127.0.0.1%3A49232%2FqbokSmrYPWk%3D%2Fws',
        'http://127.0.0.1:49227/EVgSrEEqGvY=/',
      ),
    ).toBe('ws://127.0.0.1:49232/qbokSmrYPWk=/ws');
    // WebSocket upgrade while DDS is active:
    expect(wsUrlFromRedirect('http://127.0.0.1:49232/qbokSmrYPWk=/', 'ws://127.0.0.1:49227/EVgSrEEqGvY=/ws')).toBe(
      'ws://127.0.0.1:49232/qbokSmrYPWk=/ws',
    );
    expect(wsUrlFromRedirect('/other=/', 'ws://127.0.0.1:1/x=/ws')).toBe('ws://127.0.0.1:1/other=/ws');
  });

  it('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['192.168.1.20', '10.0.2.2', 'example.com']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('redactServiceUrl hides the auth token', () => {
    expect(redactServiceUrl('http://127.0.0.1:57423/xGm5ma3sRbA=/')).toBe('http://127.0.0.1:57423/…');
  });
});
