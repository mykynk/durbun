// Dürbün SDK example: every button produces something you can watch live in
// the Dürbün desktop app (Logs, Network, Performance and Device tabs).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durbun/durbun.dart';
import 'package:flutter/material.dart';

/// Items in the demo cart (changed from the desktop through an app action).
final ValueNotifier<int> cartItems = ValueNotifier<int>(3);

Future<void> main() async {
  await Durbun.run(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      // A custom control that appears for this app on the desktop.
      Durbun.addAction(
        DurbunAction.button(
          id: 'example.clearCart',
          label: 'Clear cart',
          group: 'example',
          onPressed: (_) {
            cartItems.value = 0;
            Durbun.i('Cart cleared from the desktop', tag: 'cart');
            return {'cartItems': 0};
          },
        ),
      );
      runApp(const DurbunExampleApp());
    },
    options: const DurbunOptions(
      // Wi-Fi only: your Mac's IP (USB and simulators need nothing).
      // host: '192.168.1.20',
    ),
  );
}

class DurbunExampleApp extends StatelessWidget {
  const DurbunExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Dürbün Example',
      // In-app inspector: shake the phone (or call Durbun.showInspector()) to
      // open the panel, with or without a Mac. Nothing is drawn over the app;
      // `DurbunInspector(showBubble: true, ...)` adds a floating button.
      builder: DurbunInspector.builder,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF7C6CF2)),
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF7C6CF2),
          brightness: Brightness.dark,
        ),
      ),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  late final HttpClient _http = HttpClient();
  String _result = 'Tap a button and watch the result in the Dürbün desktop app.';
  bool _overflow = false;
  String? _imageUrl;

  @override
  void dispose() {
    _http.close();
    super.dispose();
  }

  void _show(String text) => setState(() => _result = text);

  /* ─────────────── logs ─────────────── */

  void _logAllLevels() {
    Durbun.v('Cache checked', tag: 'cache');
    Durbun.d('HomePage built', tag: 'ui', data: {'items': 24});
    Durbun.i('User signed in', tag: 'auth', data: {'userId': 42});
    Durbun.w('Token expires in 30 s', tag: 'auth');
    Durbun.e('Payment failed', tag: 'payment', error: const HttpException('402 Payment Required'));
    Durbun.f('Could not open the database', tag: 'db');
    _show('Sent 6 logs (verbose → fatal)');
  }

  void _logJson() {
    Durbun.i({
      'event': 'cart_updated',
      'items': [
        {'sku': 'TSHIRT-M', 'qty': 2, 'price': 249.9},
        {'sku': 'MUG', 'qty': 1, 'price': 129.0},
      ],
      'total': 628.8,
    }, tag: 'cart');
    _show('Sent a JSON log (opens as a tree on the desktop)');
  }

  void _print() {
    // Captured automatically when the desktop cannot see device logs.
    // ignore: avoid_print
    print('a print() line');
    debugPrint('a debugPrint() line\nsecond line');
    _show('Called print and debugPrint');
  }

  void _event() {
    Durbun.event('purchase', {'amount': 49.9, 'currency': 'USD', 'items': cartItems.value});
    _show('Sent event: purchase');
  }

  /* ─────────────── errors ─────────────── */

  void _caughtError() {
    try {
      jsonDecode('{"broken": ');
    } catch (e, st) {
      Durbun.e('Could not parse the response', tag: 'api', error: e, stackTrace: st);
    }
    _show('Sent a caught error with its stack trace');
  }

  void _flutterError() {
    setState(() => _overflow = !_overflow);
    _show(_overflow ? 'Drew an overflowing Row → FlutterError' : 'Removed the overflow');
  }

  void _zoneCrash() {
    Future<void>.delayed(Duration.zero, () {
      throw StateError('Example: uncaught async error');
    });
    _show('Threw an uncaught error → crash');
  }

  /* ─────────────── network (dart:io HttpClient) ─────────────── */

  Future<void> _request(String label, Future<HttpClientRequest> Function() open, [String? body]) async {
    final sw = Stopwatch()..start();
    try {
      final req = await open();
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(body);
      }
      final res = await req.close();
      final text = await utf8.decoder.bind(res).join();
      _show('$label → ${res.statusCode} · ${sw.elapsedMilliseconds} ms · ${text.length} characters');
    } catch (e) {
      _show('$label → ${e.runtimeType}: $e');
    }
  }

  void _getJson() => _request(
    'GET /todos/1',
    () => _http.getUrl(Uri.parse('https://jsonplaceholder.typicode.com/todos/1')),
  );

  void _postJson() => _request(
    'POST /posts',
    () => _http.postUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts')),
    jsonEncode({'title': 'Dürbün', 'body': 'Hello!', 'userId': 1}),
  );

  void _notFound() => _request(
    'GET 404',
    () => _http.getUrl(Uri.parse('https://jsonplaceholder.typicode.com/not-found')),
  );

  void _failing() => _request(
    'GET (DNS error)',
    () => _http.getUrl(Uri.parse('https://api.durbun.invalid/health')),
  );

  void _image() {
    setState(() {
      _imageUrl = 'https://picsum.photos/seed/durbun${DateTime.now().millisecond}/600/300';
    });
    _show('Loading Image.network (NetworkImage → dart:io)');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dürbün example'),
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: _ConnectionChip())],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_result, style: theme.textTheme.bodyLarge),
            ),
          ),
          ValueListenableBuilder<int>(
            valueListenable: cartItems,
            builder: (context, value, _) => ListTile(
              leading: const Icon(Icons.shopping_cart_outlined),
              title: Text('$value items in the cart'),
              subtitle: const Text('Reset it from the desktop with "Clear cart"'),
            ),
          ),
          _Section(title: 'Logs', children: [
            FilledButton.tonal(onPressed: _logAllLevels, child: const Text('All levels')),
            FilledButton.tonal(onPressed: _logJson, child: const Text('JSON log')),
            FilledButton.tonal(onPressed: _print, child: const Text('print / debugPrint')),
            FilledButton.tonal(onPressed: _event, child: const Text('Event')),
          ]),
          _Section(title: 'Errors', children: [
            FilledButton.tonal(onPressed: _caughtError, child: const Text('Durbun.e + stack')),
            FilledButton.tonal(onPressed: _flutterError, child: const Text('FlutterError (overflow)')),
            FilledButton.tonal(onPressed: _zoneCrash, child: const Text('Crash (zone)')),
          ]),
          _Section(title: 'Network', children: [
            FilledButton.tonal(onPressed: _getJson, child: const Text('GET JSON')),
            FilledButton.tonal(onPressed: _postJson, child: const Text('POST JSON')),
            FilledButton.tonal(onPressed: _notFound, child: const Text('404')),
            FilledButton.tonal(onPressed: _failing, child: const Text('Failing request')),
            FilledButton.tonal(onPressed: _image, child: const Text('Image')),
          ]),
          if (_overflow)
            // Deliberately too wide: Flutter reports a RenderFlex overflow.
            const SizedBox(
              width: 200,
              child: Row(children: [SizedBox(width: 400, height: 24, child: ColoredBox(color: Colors.amber))]),
            ),
          if (_imageUrl != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Image.network(_imageUrl!, height: 180, fit: BoxFit.cover),
              ),
            ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: children),
        ],
      ),
    );
  }
}

/// Live connection state of the SDK.
class _ConnectionChip extends StatelessWidget {
  const _ConnectionChip();

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<DurbunConnection>(
      stream: Durbun.connection,
      initialData: Durbun.connectionState,
      builder: (context, snapshot) {
        final connected = snapshot.data?.connected ?? false;
        return Chip(
          avatar: Icon(
            connected ? Icons.visibility : Icons.visibility_off_outlined,
            size: 18,
            color: connected ? Colors.green : Colors.grey,
          ),
          label: Text(connected ? 'Connected' : (Durbun.isEnabled ? 'Waiting' : 'Off')),
        );
      },
    );
  }
}
