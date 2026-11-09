/// Network statistics (tools → Statistics, and the session report's
/// header): counts, durations and bytes from the requests' metadata. Bodies
/// are never decoded; their sizes come from the capture.
library;

import 'network_model.dart';
import 'store.dart';

/// One host's line in the statistics.
class HostStats {
  HostStats(this.host);

  final String host;
  int requests = 0;
  int failures = 0;
  int bytesReceived = 0;
  double _ms = 0;
  int _timed = 0;

  /// Average duration of its responses, or null without any.
  double? get averageMs => _timed == 0 ? null : _ms / _timed;
}

class NetworkStats {
  const NetworkStats({
    required this.requests,
    required this.success,
    required this.clientErrors,
    required this.serverErrors,
    required this.failed,
    required this.timeouts,
    required this.pending,
    required this.cancelled,
    required this.timed,
    required this.averageMs,
    required this.p50Ms,
    required this.p95Ms,
    required this.maxMs,
    required this.bytesSent,
    required this.bytesReceived,
    required this.hosts,
    required this.otherHosts,
    required this.methods,
  });

  final int requests;

  /// A response below 400.
  final int success;

  /// 4xx / 5xx responses.
  final int clientErrors;
  final int serverErrors;

  /// No response: a transport error (DNS, refused, TLS, timeout…), not a
  /// cancel. [timeouts] are part of it.
  final int failed;
  final int timeouts;
  final int pending;
  final int cancelled;

  /// Responses the durations are computed over.
  final int timed;
  final double? averageMs;
  final double? p50Ms;
  final double? p95Ms;
  final double? maxMs;

  /// Request and response body sizes as captured (headers not counted).
  final int bytesSent;
  final int bytesReceived;

  /// The busiest hosts, most requests first.
  final List<HostStats> hosts;

  /// Hosts left out of [hosts].
  final int otherHosts;

  /// Requests per method (upper case), most first.
  final List<(String, int)> methods;
}

/// The [q] quantile (0…1) of [sorted] (ascending) by nearest rank: the
/// smallest value with at least q of the values at or below it. p50 of
/// [1, 2, 3, 4] is 2, p95 of 1…20 is 19. Null when empty.
double? percentile(List<double> sorted, double q) {
  if (sorted.isEmpty) return null;
  final rank = (q * sorted.length).ceil().clamp(1, sorted.length);
  return sorted[rank - 1];
}

/// Statistics of [calls]; [topHosts] hosts are listed.
NetworkStats computeNetworkStats(Iterable<InspectorCall> calls, {int topHosts = 10}) {
  var requests = 0, success = 0, client = 0, server = 0, failed = 0, timeouts = 0, pending = 0, cancelled = 0;
  var sent = 0, received = 0;
  final durations = <double>[];
  final hosts = <String, HostStats>{};
  final methods = <String, int>{};
  for (final c in calls) {
    requests++;
    final host = hosts.putIfAbsent(hostOf(c), () => HostStats(hostOf(c)))..requests += 1;
    final method = c.method.isEmpty ? 'GET' : c.method.toUpperCase();
    methods[method] = (methods[method] ?? 0) + 1;
    sent += c.requestSize ?? 0;
    final size = c.responseSize ?? 0;
    received += size;
    host.bytesReceived += size;
    // A cancel is not a failure (as the store's failure count).
    if (c.isFailure && !c.cancelled) host.failures++;
    if (c.error != null) {
      if (c.cancelled) {
        cancelled++;
      } else {
        failed++;
        if (shortErrorKey(c.error) == 'timeout') timeouts++;
      }
      continue;
    }
    final status = c.status;
    if (status == null) {
      pending++;
      continue;
    }
    if (status >= 500) {
      server++;
    } else if (status >= 400) {
      client++;
    } else {
      success++;
    }
    final d = c.duration;
    if (d != null) {
      final ms = d.inMicroseconds / 1000;
      durations.add(ms);
      host
        .._ms += ms
        .._timed += 1;
    }
  }
  durations.sort();
  final byCount = hosts.values.toList()
    ..sort((a, b) {
      final d = b.requests.compareTo(a.requests);
      return d != 0 ? d : a.host.compareTo(b.host);
    });
  final top = byCount.take(topHosts).toList();
  final methodList = <(String, int)>[for (final e in methods.entries) (e.key, e.value)]
    ..sort((a, b) {
      final d = b.$2.compareTo(a.$2);
      return d != 0 ? d : a.$1.compareTo(b.$1);
    });
  return NetworkStats(
    requests: requests,
    success: success,
    clientErrors: client,
    serverErrors: server,
    failed: failed,
    timeouts: timeouts,
    pending: pending,
    cancelled: cancelled,
    timed: durations.length,
    averageMs: durations.isEmpty ? null : durations.reduce((a, b) => a + b) / durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.isEmpty ? null : durations.last,
    bytesSent: sent,
    bytesReceived: received,
    hosts: top,
    otherHosts: byCount.length - top.length,
    methods: methodList,
  );
}
