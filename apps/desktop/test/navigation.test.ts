import { describe, expect, it } from 'vitest';
import { decideNavigation, isAllowedPermission, isAllowedRequest, isAppUrl } from '../src/navigation';

const origin = 'http://127.0.0.1:9750';

describe('isAppUrl', () => {
  it('accepts the server on the window\'s own host, http and ws', () => {
    expect(isAppUrl('http://127.0.0.1:9750/', origin)).toBe(true);
    expect(isAppUrl('http://127.0.0.1:9750/api/health', origin)).toBe(true);
    expect(isAppUrl('ws://127.0.0.1:9750/ui', origin)).toBe(true);
  });
  it('does not count other loopback names as the app (localhost may reach a program on ::1)', () => {
    expect(isAppUrl('http://localhost:9750/', origin)).toBe(false);
    expect(isAppUrl('ws://localhost:9750/ui', origin)).toBe(false);
    expect(isAppUrl('http://[::1]:9750/x', origin)).toBe(false);
    expect(isAppUrl('http://127.0.0.2:9750/x', origin)).toBe(false);
    expect(decideNavigation('http://localhost:9750/', origin)).toBe('external');
    expect(isAllowedRequest('http://localhost:9750/api/health', origin)).toBe(false);
  });
  it('rejects other ports, hosts and schemes', () => {
    expect(isAppUrl('http://127.0.0.1:5173/', origin)).toBe(false);
    expect(isAppUrl('http://localhost.evil.com:9750/', origin)).toBe(false);
    expect(isAppUrl('https://127.0.0.1:9750/', origin)).toBe(false);
    expect(isAppUrl('file:///etc/passwd', origin)).toBe(false);
    expect(isAppUrl('not a url', origin)).toBe(false);
    expect(isAppUrl('http://192.168.1.20:9750/', 'http://192.168.1.20:9750')).toBe(false);
  });
});

describe('decideNavigation', () => {
  it('keeps the app, sends web links to the browser, refuses the rest', () => {
    expect(decideNavigation('http://127.0.0.1:9750/#/network', origin)).toBe('allow');
    expect(decideNavigation('https://developer.android.com/tools/releases/platform-tools', origin)).toBe('external');
    expect(decideNavigation('mailto:team@example.com', origin)).toBe('external');
    expect(decideNavigation('file:///Users/dev/.ssh/id_rsa', origin)).toBe('deny');
    expect(decideNavigation('javascript:alert(1)', origin)).toBe('deny');
    expect(decideNavigation('http://127.0.0.1:9750/', null)).toBe('external');
  });
});

describe('isAllowedRequest', () => {
  it('only the server, data/blob and devtools', () => {
    expect(isAllowedRequest('http://127.0.0.1:9750/assets/index-abc.js', origin)).toBe(true);
    expect(isAllowedRequest('ws://127.0.0.1:9750/ui', origin)).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AAAA', origin)).toBe(true);
    expect(isAllowedRequest('blob:http://127.0.0.1:9750/uuid', origin)).toBe(true);
    expect(isAllowedRequest('https://example.com/collect?x=1', origin)).toBe(false);
    expect(isAllowedRequest('http://192.168.1.20:9750/', origin)).toBe(false);
    expect(isAllowedRequest('http://127.0.0.1:9750/', null)).toBe(false);
  });
});

describe('isAllowedPermission', () => {
  it('notifications and clipboard for the app origin only', () => {
    expect(isAllowedPermission('notifications', 'http://127.0.0.1:9750/', origin)).toBe(true);
    expect(isAllowedPermission('clipboard-sanitized-write', 'http://127.0.0.1:9750', origin)).toBe(true);
    expect(isAllowedPermission('fullscreen', 'http://127.0.0.1:9750/', origin)).toBe(true);
    expect(isAllowedPermission('notifications', 'http://localhost:9750/', origin)).toBe(false);
    expect(isAllowedPermission('clipboard-read', 'http://127.0.0.1:9750/', origin)).toBe(false);
    expect(isAllowedPermission('media', 'http://127.0.0.1:9750/', origin)).toBe(false);
    expect(isAllowedPermission('geolocation', 'http://127.0.0.1:9750/', origin)).toBe(false);
    expect(isAllowedPermission('notifications', 'https://example.com/', origin)).toBe(false);
    expect(isAllowedPermission('notifications', 'http://127.0.0.1:9750/', null)).toBe(false);
  });
});
