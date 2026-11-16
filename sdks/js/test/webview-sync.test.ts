/** The Android and iOS SDKs embed a bundled copy of webview/bridge.ts: it must match the source. */
import { describe, expect, it } from 'vitest';
import { drifted } from '../scripts/gen-webview-bridge.mjs';

describe('web view bridge copies', () => {
  it('match webview/bridge.ts (run `npm run webview:generate -w @durbun/react-native` after changing it)', () => {
    expect(drifted()).toEqual([]);
  });
});
