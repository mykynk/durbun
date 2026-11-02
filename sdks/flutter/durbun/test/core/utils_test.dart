import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:durbun/src/core/env/environment.dart';
import 'package:durbun/src/core/http/headers.dart';
import 'package:durbun/src/core/json_safe.dart';
import 'package:durbun/src/core/print_capture.dart';
import 'package:durbun/src/core/protocol.dart';
import 'package:durbun/src/core/types.dart';
import 'package:flutter_test/flutter_test.dart';

enum Plan { free, pro }

class WithToJson {
  WithToJson(this.id);
  final int id;
  Map<String, Object?> toJson() => {'id': id, 'plan': Plan.pro};
}

class Plain {
  @override
  String toString() => 'Plain#1';
}

void main() {
  group('toJsonSafe', () {
    test('keeps JSON values, converts the rest', () {
      final result = toJsonSafe({
        'n': 1,
        'd': 2.5,
        'nan': double.nan,
        'inf': double.infinity,
        'b': true,
        'nil': null,
        'date': DateTime.utc(2026, 11, 2, 9, 30),
        'dur': const Duration(milliseconds: 1500),
        'uri': Uri.parse('https://x.dev/a?b=1'),
        'enum': Plan.free,
        'bytes': Uint8List.fromList([1, 2, 3]),
        'obj': WithToJson(7),
        'plain': Plain(),
        'set': {1, 2},
        3: 'int key',
      });
      expect(result, {
        'n': 1,
        'd': 2.5,
        'nan': 'NaN',
        'inf': 'Infinity',
        'b': true,
        'nil': null,
        'date': '2026-11-02T09:30:00.000Z',
        'dur': '0:00:01.500000',
        'uri': 'https://x.dev/a?b=1',
        'enum': 'free',
        'bytes': 'bytes(3): AQID',
        'obj': {'id': 7, 'plan': 'pro'},
        'plain': 'Plain#1',
        'set': [1, 2],
        '3': 'int key',
      });
      expect(() => jsonEncode(result), returnsNormally);
    });

    test('cycles and depth are bounded', () {
      final cyclic = <String, Object?>{'name': 'root'};
      cyclic['self'] = cyclic;
      expect(toJsonSafe(cyclic), {'name': 'root', 'self': '<cycle>'});
      Object? deep = 'leaf';
      for (var i = 0; i < 40; i++) {
        deep = [deep];
      }
      expect(jsonEncode(toJsonSafe(deep)), contains('<max depth>'));
    });

    test('stringifyMessage renders maps/lists as compact JSON', () {
      expect(stringifyMessage('plain'), 'plain');
      expect(stringifyMessage({'a': 1, 'b': [true]}), '{"a":1,"b":[true]}');
      expect(stringifyMessage(null), 'null');
      expect(stringifyMessage(42), '42');
    });

    test('capString', () {
      expect(capString('abc', 5), 'abc');
      expect(capString('abcdefgh', 3), 'abc… [5 more characters]');
    });
  });

  group('DurbunHttpHeaders', () {
    test('add/set/value/remove semantics like dart:io', () {
      final h = DurbunHttpHeaders();
      h.add('Accept', 'application/json');
      h.add('accept', 'text/plain');
      expect(h['ACCEPT'], ['application/json', 'text/plain']);
      expect(() => h.value('accept'), throwsA(isA<HttpException>()));
      h.set('X-Trace-Id', 'abc', preserveHeaderCase: true);
      final names = <String>[];
      h.forEach((name, _) => names.add(name));
      expect(names, ['accept', 'X-Trace-Id']);
      h.add('content-type', 'text/plain');
      h.add('content-type', 'application/json; charset=utf-8'); // single-valued
      expect(h.contentType?.mimeType, 'application/json');
      expect(h.contentType?.charset, 'utf-8');
      h.remove('accept', 'text/plain');
      expect(h['accept'], ['application/json']);
      h.removeAll('accept');
      expect(h['accept'], isNull);
      h.add('x-list', ['a', 'b']);
      expect(h['x-list'], ['a', 'b']);
    });

    test('typed accessors', () {
      final h = DurbunHttpHeaders(defaultPort: 443);
      h.contentLength = 42;
      expect(h.value('content-length'), '42');
      expect(h.contentLength, 42);
      h.contentLength = -1;
      expect(h['content-length'], isNull);
      h.host = 'api.example.com';
      h.port = 8443;
      expect(h.value('host'), 'api.example.com:8443');
      expect(h.port, 8443);
      final date = DateTime.utc(2026, 11, 2, 12);
      h.date = date;
      expect(h.value('date'), 'Mon, 02 Nov 2026 12:00:00 GMT');
      expect(h.date, date);
      expect(h.persistentConnection, isTrue);
      h.persistentConnection = false;
      expect(h.value('connection'), 'close');
      h.chunkedTransferEncoding = true;
      expect(h.chunkedTransferEncoding, isTrue);
    });

    test('frozen headers reject changes; invalid names are rejected', () {
      final h = DurbunHttpHeaders.fromPairs([
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ]);
      expect(h['set-cookie'], ['a=1', 'b=2']);
      expect(h.toPairs().first, ['Content-Type', 'application/json']);
      expect(() => h.set('x', 'y'), throwsA(isA<HttpException>()));
      expect(() => DurbunHttpHeaders().add('bad name', 'x'), throwsFormatException);
    });
  });

  group('environment helpers', () {
    test('splitHostPort', () {
      expect(splitHostPort('192.168.1.20', 9751), ('192.168.1.20', 9751));
      expect(splitHostPort(' 192.168.1.20:9000 ', 9751), ('192.168.1.20', 9000));
      expect(splitHostPort('[fe80::1]:9000', 9751), ('fe80::1', 9000));
      expect(splitHostPort('fe80::1', 9751), ('fe80::1', 9751));
      expect(splitHostPort('http://yusuf-mac.local:1234/x', 9751), ('yusuf-mac.local', 1234));
      expect(splitHostPort('yusuf-mac.local', 9751), ('yusuf-mac.local', 9751));
    });

    test('nameFromIdentifier', () {
      expect(nameFromIdentifier('com.mykynk.pati'), 'Pati');
      expect(nameFromIdentifier('dev.durbun.my_cool_app'), 'My cool app');
      expect(nameFromIdentifier('runner'), 'Runner');
    });

    test('parseDarwinOsVersion', () {
      expect(parseDarwinOsVersion('Version 17.2 (Build 21C62)'), '17.2');
      expect(parseDarwinOsVersion('Version 26.0.1 (Build 25A362)'), '26.0.1');
      expect(parseDarwinOsVersion('weird'), isNull);
    });

    test('detectApp honours overrides; detectDevice never throws', () {
      final app = detectApp(
        idOverride: 'com.example.override',
        nameOverride: 'Override',
        versionOverride: '9.9.9',
      );
      expect(app.id, 'com.example.override');
      expect(app.name, 'Override');
      expect(app.version, '9.9.9');
      final auto = detectApp();
      expect(auto.id, isNotEmpty);
      final device = detectDevice();
      expect(['android', 'ios', 'other'], contains(device.platform));
      expect(device.toJson()['platform'], device.platform);
    });

    test('device listen ports are 9752..9755', () {
      expect(deviceListenPorts(), [9752, 9753, 9754, 9755]);
    });
  });

  group('PrintCapture', () {
    test('auto: holds lines until the config says whether device logs exist', () {
      final sent = <String>[];
      final capture = PrintCapture(
        mode: DurbunPrintCapture.auto,
        sink: (line, ts) => sent.add(line),
      );
      capture.onLine('early 1');
      capture.onLine('early 2');
      expect(sent, isEmpty);
      expect(capture.pendingCount, 2);
      capture.onConfig(SdkConfig.defaults); // deviceLogsAvailable: false
      expect(sent, ['early 1', 'early 2']);
      capture.onLine('later');
      expect(sent.last, 'later');
    });

    test('auto + deviceLogsAvailable drops lines (no duplicates)', () {
      final sent = <String>[];
      final capture = PrintCapture(
        mode: DurbunPrintCapture.auto,
        sink: (line, ts) => sent.add(line),
      )..onLine('pending');
      capture.onConfig(
        const SdkConfig(
          captureBodies: true,
          maxBodyBytes: 1,
          metricsIntervalMs: 1000,
          deviceLogsAvailable: true,
        ),
      );
      capture.onLine('ignored');
      expect(sent, isEmpty);
      expect(capture.pendingCount, 0);
    });

    test('always / never', () {
      final sent = <String>[];
      PrintCapture(mode: DurbunPrintCapture.always, sink: (l, _) => sent.add(l)).onLine('a');
      PrintCapture(mode: DurbunPrintCapture.never, sink: (l, _) => sent.add(l)).onLine('b');
      expect(sent, ['a']);
    });

    test('drops the console copy of Flutter error boxes', () {
      final sent = <String>[];
      final capture = PrintCapture(
        mode: DurbunPrintCapture.always,
        dropFlutterErrorBoxes: true,
        sink: (l, _) => sent.add(l),
      );
      for (final line in [
        'before',
        '══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════════════════════════════════════',
        'The following assertion was thrown during layout:',
        'A RenderFlex overflowed by 42 pixels on the bottom.',
        '════════════════════════════════════════════════════════════════════════════════════════════════════',
        'Another exception was thrown: A RenderFlex overflowed by 42 pixels on the bottom.',
        'after',
      ]) {
        capture.onLine(line);
      }
      expect(sent, ['before', 'after']);
    });
  });

  group('DurbunAction', () {
    test('toggle: explicit values, string values and flip', () async {
      var on = false;
      final a = DurbunAction.toggle(
        id: 'x.toggle',
        label: 'Toggle',
        group: 'x',
        value: () => on,
        onChanged: (v) => on = v,
      );
      expect(a.describe(), {
        'id': 'x.toggle',
        'kind': 'toggle',
        'label': 'Toggle',
        'group': 'x',
        'value': false,
      });
      expect(await a.invoke({'value': true}), {'value': true});
      expect(await a.invoke({'enabled': 'false'}), {'value': false});
      expect(await a.invoke({}), {'value': true});
    });

    test('select validates options (case-insensitive)', () async {
      var mode = 'system';
      final a = DurbunAction.select(
        id: 'x.mode',
        label: 'Mode',
        options: const [DurbunActionOption('system', 'System'), DurbunActionOption('iOS', 'iOS')],
        value: () => mode,
        onChanged: (v) => mode = v,
      );
      expect(await a.invoke({'value': 'ios'}), {'value': 'iOS'});
      expect(() => a.invoke({'value': 'web'}), throwsArgumentError);
      expect(() => a.invoke({}), throwsArgumentError);
      expect(a.describe()['options'], [
        {'value': 'system', 'label': 'System'},
        {'value': 'iOS', 'label': 'iOS'},
      ]);
    });

    test('parseBoolParam', () {
      expect(parseBoolParam(true), isTrue);
      expect(parseBoolParam('on'), isTrue);
      expect(parseBoolParam(0), isFalse);
      expect(parseBoolParam('maybe'), isNull);
    });
  });
}
