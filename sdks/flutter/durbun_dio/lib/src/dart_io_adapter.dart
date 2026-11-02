import 'package:dio/dio.dart';
import 'package:dio/io.dart';

/// Whether [adapter] sends through dart:io's `HttpClient`, which
/// package:durbun already captures. A type check rather than the class name:
/// names are minified in `--obfuscate` builds.
bool usesDartIoHttpClient(HttpClientAdapter adapter) =>
    adapter is IOHttpClientAdapter;
