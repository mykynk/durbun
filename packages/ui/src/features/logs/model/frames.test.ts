import { describe, expect, it } from 'vitest';
import { appIdentity, firstAppFrame, frameDisplayText, parseStack, parseStackLine } from './frames';

const pati = appIdentity([{ id: 'com.mykynk.pati', name: 'Pati', processName: 'Runner' }]);
const mahalle = appIdentity([{ id: 'com.mykynk.mahalle', name: 'Mahalle' }]);

describe('appIdentity', () => {
  it('derives Dart packages, Java prefixes and Apple modules from the app', () => {
    expect(pati.dartPackages).toContain('pati');
    expect(pati.javaPrefixes).toContain('com.mykynk.pati.');
    expect(pati.modules).toEqual(expect.arrayContaining(['Runner', 'Pati', 'pati']));
  });
});

describe('stack frame classification', () => {
  it('Dart: app package highlighted, Flutter/dart: dimmed, other packages neutral', () => {
    expect(parseStackLine('#0      PaymentService.charge (package:pati/core/payment/payment_service.dart:88:7)', pati).cls).toBe('app');
    expect(parseStackLine('#1      StreamBuilder.build (package:flutter/src/widgets/async.dart:442:81)', pati).cls).toBe('framework');
    expect(parseStackLine('#15     _invoke (dart:ui/hooks.dart:316:13)', pati).cls).toBe('framework');
    expect(parseStackLine('#4      Dio.fetch (package:dio/src/dio_mixin.dart:12:3)', pati).cls).toBe('other');
    expect(parseStackLine('#2      main (file:///Users/deniz/dev/pati/lib/main.dart:10:3)', pati).cls).toBe('app');
    expect(parseStackLine('<asynchronous suspension>', pati).type).toBe('meta');
  });

  it('Java/Kotlin: the app package is highlighted, platform and libraries dimmed', () => {
    expect(parseStackLine('\tat com.mykynk.mahalle.ui.basket.BasketFragment.renderTotals(BasketFragment.kt:214)', mahalle).cls).toBe('app');
    expect(parseStackLine('\tat androidx.fragment.app.Fragment.requireContext(Fragment.java:972)', mahalle).cls).toBe('framework');
    expect(parseStackLine('\tat android.os.Looper.loop(Looper.java:317)', mahalle).cls).toBe('framework');
    expect(parseStackLine('\tat okhttp3.internal.http.RealInterceptorChain.proceed(RealInterceptorChain.kt:109)', mahalle).cls).toBe('framework');
    expect(parseStackLine('\tat bfrq.a(:com.google.android.gms@244735035@24.47.35 (260400-703785403):36)', mahalle).cls).toBe('other');
    expect(parseStackLine('Caused by: java.lang.NullPointerException: x', mahalle).type).toBe('cause');
    expect(parseStackLine('\t... 12 more', mahalle).type).toBe('meta');
  });

  it('Apple: the app module is highlighted, system frameworks dimmed', () => {
    expect(parseStackLine('3   Runner                              0x0000000104a1c2d8 AppDelegate.application(_:didFinishLaunchingWithOptions:) + 120', pati).cls).toBe('app');
    expect(parseStackLine('4   UIKitCore                           0x0000000185a1c2d8 -[UIApplication sendEvent:] + 64', pati).cls).toBe('framework');
    expect(parseStackLine('5   libsystem_kernel.dylib              0x00000001d0d1c2d8 __pthread_kill + 8', pati).cls).toBe('framework');
  });

  it('JavaScript: node_modules / RN internals dimmed, app files highlighted', () => {
    expect(parseStackLine('    at onPress (/app/src/screens/Login.tsx:42:13)').cls).toBe('app');
    expect(parseStackLine('    at invokeGuardedCallback (node_modules/react-native/Libraries/Renderer/x.js:1:2)').cls).toBe('framework');
  });

  it('parses a whole trace and finds the first app frame', () => {
    const s = parseStack(
      'java.lang.IllegalStateException: boom\n\tat androidx.fragment.app.Fragment.requireContext(Fragment.java:972)\n\n\tat com.mykynk.mahalle.ui.Basket.render(Basket.kt:12)\n\tat android.os.Handler.handleCallback(Handler.java:959)',
      mahalle,
    );
    expect(s.frames).toBe(3);
    expect(s.appFrames).toBe(1);
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]!.type).toBe('cause');
    expect(firstAppFrame(s)?.text).toContain('Basket.render');
  });
});

describe('frameDisplayText', () => {
  it('drops the leading indent and glues "at" / "#N" to the symbol', () => {
    expect(frameDisplayText('\tat com.example.Main.run(Main.kt:3)')).toBe('at com.example.Main.run(Main.kt:3)');
    expect(frameDisplayText('#12     StatefulElement.build (package:flutter/src/widgets/framework.dart:5841:27)')).toBe('#12 StatefulElement.build (package:flutter/src/widgets/framework.dart:5841:27)');
    expect(frameDisplayText('  3   UIKitCore  0x1  -[UIApplication run] + 12')).toBe('3   UIKitCore  0x1  -[UIApplication run] + 12');
  });
});
