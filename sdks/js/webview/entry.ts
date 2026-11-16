// The injected script: bundled from here into the copies the native SDKs embed (scripts/gen-webview-bridge.mjs).
import { bootstrap } from './bridge';

bootstrap(typeof window !== 'undefined' ? window : globalThis);
