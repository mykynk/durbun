import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n';
import { clockSkewOf, clockSkewText, protocolMismatchText, protocolText } from './session';
import './text';

describe('app session notes', () => {
  it('says nothing for a clock within five seconds or not measured', () => {
    expect(clockSkewOf({ clockOffsetMs: 4_999 })).toBeUndefined();
    expect(clockSkewOf({ clockOffsetMs: -5_000 })).toBeUndefined();
    expect(clockSkewOf({})).toBeUndefined();
    expect(clockSkewOf(undefined)).toBeUndefined();
  });

  it('words the device clock against the Mac (Mac minus device)', () => {
    setLanguage('tr');
    expect(clockSkewText(clockSkewOf({ clockOffsetMs: 47_260, clockOffsetAccuracyMs: 180 })!)).toBe('Cihaz saati Mac’ten 47 sn geri (± 180 ms)');
    setLanguage('en');
    expect(clockSkewText(clockSkewOf({ clockOffsetMs: -12_400 })!)).toBe('The device clock is 12 s ahead of the Mac');
    expect(clockSkewText(clockSkewOf({ clockOffsetMs: 185_000 })!)).toBe('The device clock is 3m 5s behind the Mac');
  });

  it('names the protocol and what to update on a mismatch', () => {
    setLanguage('en');
    expect(protocolText({ sdkProtocol: 2 })).toBe('protocol 2');
    expect(protocolText({})).toBeUndefined();
    expect(protocolMismatchText({ protocolMismatch: 'sdk-newer' })?.label).toBe('Update Dürbün');
    expect(protocolMismatchText({ protocolMismatch: 'sdk-older' })?.label).toBe('Update the SDK');
    expect(protocolMismatchText({})).toBeUndefined();
  });
});
