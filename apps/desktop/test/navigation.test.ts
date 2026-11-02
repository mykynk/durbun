import { describe, expect, it } from 'vitest';
import { decideNavigation, isAllowedPermission, isAllowedRequest, isAppUrl } from '../src/navigation';

const origin = 'http://localhost:9750';

describe('isAppUrl', () => {
  it('accepts the server on any loopback name, http and ws', () => {
    expect(isAppUrl('http://localhost:9750/', origin)).toBe(true);
    expect(isAppUrl('http://127.0.0.1:9750/api/health', origin)).toBe(true);
    expect(isAppUrl('http://[::1]:9750/x', origin)).toBe(true);
    expect(isAppUrl('ws://localhost:9750/ui', origin)).toBe(true);
  });
  it('rejects other ports, hosts and schemes', () => {
    expect(isAppUrl('http://localhost:5173/', origin)).toBe(false);
    expect(isAppUrl('http://localhost.evil.com:9750/', origin)).toBe(false);
    expect(isAppUrl('https://localhost:9750/', origin)).toBe(false);
    expect(isAppUrl('file:///etc/passwd', origin)).toBe(false);
    expect(isAppUrl('not a url', origin)).toBe(false);
  });
});

describe('decideNavigation', () => {
  it('keeps the app, sends web links to the browser, refuses the rest', () => {
    expect(decideNavigation('http://localhost:9750/#/network', origin)).toBe('allow');
    expect(decideNavigation('https://developer.android.com/tools/releases/platform-tools', origin)).toBe('external');
    expect(decideNavigation('mailto:team@example.com', origin)).toBe('external');
    expect(decideNavigation('file:///Users/dev/.ssh/id_rsa', origin)).toBe('deny');
    expect(decideNavigation('javascript:alert(1)', origin)).toBe('deny');
    expect(decideNavigation('http://localhost:9750/', null)).toBe('external');
  });
});

describe('isAllowedRequest', () => {
  it('only the server, data/blob and devtools', () => {
    expect(isAllowedRequest('http://localhost:9750/assets/index-abc.js', origin)).toBe(true);
    expect(isAllowedRequest('ws://127.0.0.1:9750/ui', origin)).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AAAA', origin)).toBe(true);
    expect(isAllowedRequest('blob:http://localhost:9750/uuid', origin)).toBe(true);
    expect(isAllowedRequest('https://example.com/collect?x=1', origin)).toBe(false);
    expect(isAllowedRequest('http://192.168.1.20:9750/', origin)).toBe(false);
    expect(isAllowedRequest('http://localhost:9750/', null)).toBe(false);
  });
});

describe('isAllowedPermission', () => {
  it('notifications and clipboard for the app origin only', () => {
    expect(isAllowedPermission('notifications', 'http://localhost:9750/', origin)).toBe(true);
    expect(isAllowedPermission('clipboard-sanitized-write', 'http://127.0.0.1:9750', origin)).toBe(true);
    expect(isAllowedPermission('media', 'http://localhost:9750/', origin)).toBe(false);
    expect(isAllowedPermission('geolocation', 'http://localhost:9750/', origin)).toBe(false);
    expect(isAllowedPermission('notifications', 'https://example.com/', origin)).toBe(false);
    expect(isAllowedPermission('notifications', 'http://localhost:9750/', null)).toBe(false);
  });
});
