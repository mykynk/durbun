/**
 * Stack-trace line parsing and classification: the app's own frames are highlighted, framework frames
 * dimmed (SPEC §1.1-3). Handles Dart (`#0 … (package:x/…)`), Java/Kotlin (`at a.b.C.m(C.kt:1)`),
 * JavaScript (`at fn (file:1:2)`) and Apple (`3 UIKitCore 0x… symbol + 12`) frames.
 */

export type FrameClass = 'app' | 'framework' | 'other';

export interface StackLine {
  text: string;
  /** 'frame' = a stack frame; 'cause' = "Caused by:" / exception header inside a trace; 'meta' = async gaps, "… N more"; 'text' = anything else. */
  type: 'frame' | 'cause' | 'meta' | 'text';
  cls?: FrameClass;
}

/** What identifies the app's own code inside stack frames. */
export interface AppIdentity {
  /** Dart package names (`package:<name>/…`). */
  dartPackages: readonly string[];
  /** Java/Kotlin class prefixes (bundle id + '.'). */
  javaPrefixes: readonly string[];
  /** Apple binary/module names (e.g. "Runner", "Pati"). */
  modules: readonly string[];
}

export const NO_IDENTITY: AppIdentity = { dartPackages: [], javaPrefixes: [], modules: [] };

const snake = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Build an identity from app sessions' bundle ids, names and process names. */
export function appIdentity(apps: ReadonlyArray<{ id: string; name?: string; processName?: string }>): AppIdentity {
  const dart = new Set<string>();
  const java = new Set<string>();
  const modules = new Set<string>();
  for (const a of apps) {
    const bundle = a.id.trim();
    if (bundle) {
      java.add(`${bundle}.`);
      const last = bundle.split('.').pop() ?? '';
      if (last) {
        dart.add(snake(last));
        modules.add(last);
        modules.add(last.charAt(0).toUpperCase() + last.slice(1));
      }
    }
    if (a.name) {
      const s = snake(a.name);
      if (s) dart.add(s);
      modules.add(a.name.replace(/\s+/g, ''));
    }
    if (a.processName) modules.add(a.processName);
  }
  dart.delete('');
  return { dartPackages: [...dart], javaPrefixes: [...java], modules: [...modules].filter(Boolean) };
}

const DART_FRAME = /^#\d+\s+(.*?)\s*\((.+)\)\s*$/;
const DART_FRAME_NOLOC = /^#\d+\s+\S/;
const JAVA_FRAME = /^\s*at\s+([\w$.<>/-]+)\((.*)\)\s*$/;
const JS_FRAME = /^\s*at\s+(?:(.+?)\s+\()?([^()\s]+?):(\d+)(?::(\d+))?\)?\s*$/;
const APPLE_FRAME = /^\s*\d+\s+(\S+)\s+0x[0-9a-fA-F]+\s+(.*)$/;
const CAUSE = /^\s*(Caused by:|Suppressed:|Exception in thread|java\.|kotlin\.|[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+(Exception|Error|Throwable)\b)/;
const META = /^\s*(<asynchronous suspension>|\.\.\. \d+ more|\.\.\.|…)\s*$/;

const JAVA_FRAMEWORK = [
  'android.',
  'androidx.',
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'kotlin.',
  'kotlinx.',
  'com.android.',
  'dalvik.',
  'libcore.',
  'com.google.android.',
  'okhttp3.',
  'okio.',
  'retrofit2.',
  'io.flutter.',
  'dev.durbun.',
];

const APPLE_FRAMEWORK = new Set([
  'UIKitCore',
  'UIKit',
  'CoreFoundation',
  'Foundation',
  'GraphicsServices',
  'QuartzCore',
  'SwiftUI',
  'SwiftUICore',
  'CFNetwork',
  'Flutter',
  'dyld',
  'libdispatch.dylib',
  'libobjc.A.dylib',
  'libswiftCore.dylib',
  'libc++abi.dylib',
  'libsystem_kernel.dylib',
  'libsystem_pthread.dylib',
  'libsystem_c.dylib',
  'libdyld.dylib',
  'FrontBoardServices',
  'BaseBoard',
  'RunningBoardServices',
]);

function classifyDart(loc: string, id: AppIdentity): FrameClass {
  if (loc.startsWith('dart:') || loc.startsWith('package:flutter/') || loc.startsWith('package:flutter_test/')) return 'framework';
  if (loc.startsWith('package:')) {
    const slash = loc.indexOf('/');
    const pkg = loc.slice(8, slash < 0 ? undefined : slash);
    return id.dartPackages.includes(pkg) ? 'app' : 'other';
  }
  if (loc.startsWith('file://') && loc.includes('/lib/')) return 'app';
  return 'other';
}

function classifyJava(symbol: string, id: AppIdentity): FrameClass {
  for (const p of id.javaPrefixes) if (symbol.startsWith(p)) return 'app';
  for (const p of JAVA_FRAMEWORK) if (symbol.startsWith(p)) return 'framework';
  return 'other';
}

function classifyApple(module: string, id: AppIdentity): FrameClass {
  if (id.modules.includes(module)) return 'app';
  if (APPLE_FRAMEWORK.has(module) || module.startsWith('libsystem_') || module.startsWith('libswift')) return 'framework';
  return 'other';
}

function classifyJs(file: string): FrameClass {
  if (file.includes('node_modules') || file.includes('react-native/Libraries') || file.startsWith('native') || file.startsWith('internal/')) return 'framework';
  return 'app';
}

/** Parse one line of a stack trace. */
export function parseStackLine(line: string, id: AppIdentity = NO_IDENTITY): StackLine {
  if (META.test(line)) return { text: line, type: 'meta' };
  let m = DART_FRAME.exec(line);
  if (m) return { text: line, type: 'frame', cls: classifyDart(m[2]!.trim(), id) };
  if (DART_FRAME_NOLOC.test(line)) return { text: line, type: 'frame', cls: 'other' };
  m = JAVA_FRAME.exec(line);
  if (m) {
    // Kotlin/Java frames look like `at pkg.Class.method(File.kt:12)`; JS frames have a `file:line:col` location.
    const loc = m[2]!;
    if (!/:\d+:\d+$/.test(loc) || /\.(kt|java):\d+$/.test(loc)) return { text: line, type: 'frame', cls: classifyJava(m[1]!, id) };
  }
  m = JS_FRAME.exec(line);
  if (m) return { text: line, type: 'frame', cls: classifyJs(m[2]!) };
  m = APPLE_FRAME.exec(line);
  if (m) return { text: line, type: 'frame', cls: classifyApple(m[1]!, id) };
  if (CAUSE.test(line)) return { text: line, type: 'cause' };
  return { text: line, type: 'text' };
}

export function isFrameLine(line: string): boolean {
  return DART_FRAME_NOLOC.test(line) || JAVA_FRAME.test(line) || JS_FRAME.test(line) || APPLE_FRAME.test(line);
}

export interface ParsedStack {
  lines: StackLine[];
  frames: number;
  appFrames: number;
}

/** Parse a whole stack trace text (blank lines dropped). */
export function parseStack(text: string, id: AppIdentity = NO_IDENTITY): ParsedStack {
  const lines: StackLine[] = [];
  let frames = 0;
  let appFrames = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const l = parseStackLine(raw.replace(/\r$/, ''), id);
    if (l.type === 'frame') {
      frames++;
      if (l.cls === 'app') appFrames++;
    }
    lines.push(l);
  }
  return { lines, frames, appFrames };
}

/** First frame that belongs to the app (the most useful one-line location), or undefined. */
export function firstAppFrame(stack: ParsedStack): StackLine | undefined {
  return stack.lines.find((l) => l.type === 'frame' && l.cls === 'app');
}

/**
 * Frame text for display: the leading tab / spaces become a CSS hanging indent (a wrapped `\tat …` frame
 * must not leave "at" alone on a line) and Dart's padded frame numbers (`#0      main`) shrink to one gap
 * — a no-break space, so the symbol wraps instead of leaving the keyword alone on a line.
 */
export function frameDisplayText(text: string): string {
  return text
    .trim()
    .replace(/^(#\d+)\s+/, '$1 ')
    .replace(/^at\s+/, 'at ');
}
