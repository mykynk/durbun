/// Tiny FFI helpers (libc only, no package dependencies): Android system
/// properties, Darwin sysctl strings and process CPU time. Every helper
/// returns null instead of throwing.
library;

import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

typedef _MallocC = Pointer<Void> Function(Size);
typedef _MallocDart = Pointer<Void> Function(int);
typedef _FreeC = Void Function(Pointer<Void>);
typedef _FreeDart = void Function(Pointer<Void>);

class _Libc {
  _Libc._(this.lib)
    : malloc = lib.lookupFunction<_MallocC, _MallocDart>('malloc'),
      free = lib.lookupFunction<_FreeC, _FreeDart>('free');

  final DynamicLibrary lib;
  final _MallocDart malloc;
  final _FreeDart free;

  static _Libc? _instance;
  static bool _failed = false;

  static _Libc? get instance {
    if (_instance != null || _failed) return _instance;
    try {
      final lib = Platform.isAndroid || Platform.isLinux
          ? _openFirst(const ['libc.so', 'libc.so.6'])
          : DynamicLibrary.process();
      _instance = _Libc._(lib);
    } catch (_) {
      _failed = true;
    }
    return _instance;
  }

  static DynamicLibrary _openFirst(List<String> names) {
    for (final name in names) {
      try {
        return DynamicLibrary.open(name);
      } catch (_) {}
    }
    return DynamicLibrary.process();
  }

  Pointer<Uint8> cString(String value) {
    final encoded = utf8.encode(value);
    final p = malloc(encoded.length + 1).cast<Uint8>();
    p.asTypedList(encoded.length + 1)
      ..setAll(0, encoded)
      ..[encoded.length] = 0;
    return p;
  }
}

String _readCString(Pointer<Uint8> p, int max) {
  final bytes = p.asTypedList(max);
  var end = bytes.indexOf(0);
  if (end < 0) end = max;
  return utf8.decode(Uint8List.fromList(bytes.sublist(0, end)), allowMalformed: true);
}

typedef _PropGetC = Int32 Function(Pointer<Uint8>, Pointer<Uint8>);
typedef _PropGetDart = int Function(Pointer<Uint8>, Pointer<Uint8>);

_PropGetDart? _propGet;
bool _propGetFailed = false;

/// Android `__system_property_get(name)`; null when unavailable or empty.
String? androidSystemProperty(String name) {
  if (!Platform.isAndroid) return null;
  final libc = _Libc.instance;
  if (libc == null || _propGetFailed) return null;
  try {
    _propGet ??= libc.lib.lookupFunction<_PropGetC, _PropGetDart>(
      '__system_property_get',
    );
  } catch (_) {
    _propGetFailed = true;
    return null;
  }
  const propValueMax = 92;
  final namePtr = libc.cString(name);
  final valuePtr = libc.malloc(propValueMax + 8).cast<Uint8>();
  try {
    valuePtr.asTypedList(propValueMax + 8).fillRange(0, propValueMax + 8, 0);
    final len = _propGet!(namePtr, valuePtr);
    if (len <= 0) return null;
    final value = _readCString(valuePtr, propValueMax + 8).trim();
    return value.isEmpty ? null : value;
  } catch (_) {
    return null;
  } finally {
    libc.free(namePtr.cast());
    libc.free(valuePtr.cast());
  }
}

typedef _SysctlC =
    Int32 Function(Pointer<Uint8>, Pointer<Void>, Pointer<Size>, Pointer<Void>, Size);
typedef _SysctlDart =
    int Function(Pointer<Uint8>, Pointer<Void>, Pointer<Size>, Pointer<Void>, int);

/// Darwin `sysctlbyname(name)` for string values (e.g. `hw.machine` →
/// `iPhone16,2` on a physical iPhone).
String? darwinSysctlString(String name) {
  if (!Platform.isIOS && !Platform.isMacOS) return null;
  final libc = _Libc.instance;
  if (libc == null) return null;
  try {
    final sysctl = libc.lib.lookupFunction<_SysctlC, _SysctlDart>(
      'sysctlbyname',
    );
    final namePtr = libc.cString(name);
    final lenPtr = libc.malloc(sizeOf<Size>()).cast<Size>();
    try {
      lenPtr.value = 0;
      if (sysctl(namePtr, nullptr, lenPtr, nullptr, 0) != 0) return null;
      final len = lenPtr.value;
      if (len <= 0 || len > 4096) return null;
      final buf = libc.malloc(len + 1).cast<Uint8>();
      try {
        buf.asTypedList(len + 1).fillRange(0, len + 1, 0);
        if (sysctl(namePtr, buf.cast(), lenPtr, nullptr, 0) != 0) return null;
        final value = _readCString(buf, len + 1).trim();
        return value.isEmpty ? null : value;
      } finally {
        libc.free(buf.cast());
      }
    } finally {
      libc.free(namePtr.cast());
      libc.free(lenPtr.cast());
    }
  } catch (_) {
    return null;
  }
}

typedef _GetrusageC = Int32 Function(Int32, Pointer<Uint8>);
typedef _GetrusageDart = int Function(int, Pointer<Uint8>);

_GetrusageDart? _getrusage;
bool _getrusageFailed = false;

/// User + system CPU time of this process in microseconds (`getrusage`),
/// falling back to `/proc/self/stat` on Linux/Android.
int? processCpuTimeMicros() {
  final viaRusage = _rusageMicros();
  if (viaRusage != null) return viaRusage;
  return _procStatCpuMicros();
}

int? _rusageMicros() {
  if (_getrusageFailed) return null;
  if (!(Platform.isAndroid ||
      Platform.isIOS ||
      Platform.isMacOS ||
      Platform.isLinux)) {
    return null;
  }
  final libc = _Libc.instance;
  if (libc == null) return null;
  try {
    _getrusage ??= libc.lib.lookupFunction<_GetrusageC, _GetrusageDart>(
      'getrusage',
    );
  } catch (_) {
    _getrusageFailed = true;
    return null;
  }
  const bufSize = 512; // struct rusage is ~144 bytes on 64-bit platforms.
  final buf = libc.malloc(bufSize).cast<Uint8>();
  try {
    final view = buf.asTypedList(bufSize)..fillRange(0, bufSize, 0);
    if (_getrusage!(0 /* RUSAGE_SELF */, buf) != 0) return null;
    final data = ByteData.sublistView(view);
    // struct timeval ru_utime, ru_stime: {time_t tv_sec; suseconds_t tv_usec}
    // 64-bit: 16 bytes each (tv_usec is 4 bytes + padding on Darwin, 8 on
    // Linux; reading 4 little-endian bytes works for both). 32-bit: 8 bytes.
    final wide = sizeOf<IntPtr>() == 8;
    final int uSec, uUsec, sSec, sUsec;
    if (wide) {
      uSec = data.getInt64(0, Endian.host);
      uUsec = data.getInt32(8, Endian.host);
      sSec = data.getInt64(16, Endian.host);
      sUsec = data.getInt32(24, Endian.host);
    } else {
      uSec = data.getInt32(0, Endian.host);
      uUsec = data.getInt32(4, Endian.host);
      sSec = data.getInt32(8, Endian.host);
      sUsec = data.getInt32(12, Endian.host);
    }
    final total = (uSec + sSec) * 1000000 + uUsec + sUsec;
    return total >= 0 ? total : null;
  } catch (_) {
    _getrusageFailed = true;
    return null;
  } finally {
    libc.free(buf.cast());
  }
}

int? _procStatCpuMicros() {
  final fields = readProcSelfStat();
  if (fields == null) return null;
  final utime = int.tryParse(fields.length > 11 ? fields[11] : '');
  final stime = int.tryParse(fields.length > 12 ? fields[12] : '');
  if (utime == null || stime == null) return null;
  const clockTicksPerSecond = 100; // USER_HZ on Linux/Android.
  return (utime + stime) * (1000000 ~/ clockTicksPerSecond);
}

/// Fields of `/proc/self/stat` after the `(comm)` field (index 0 = state,
/// i.e. field 3 of proc(5)); null where /proc is unavailable.
List<String>? readProcSelfStat() {
  if (!(Platform.isAndroid || Platform.isLinux)) return null;
  try {
    final text = File('/proc/self/stat').readAsStringSync();
    final close = text.lastIndexOf(')');
    if (close < 0) return null;
    return text.substring(close + 1).trim().split(RegExp(r'\s+'));
  } catch (_) {
    return null;
  }
}

/// Number of threads (Linux/Android only).
int? processThreadCount() {
  final fields = readProcSelfStat();
  if (fields == null || fields.length <= 17) return null;
  return int.tryParse(fields[17]);
}
