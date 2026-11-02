import 'package:dio/dio.dart';

/// No dart:io on this platform (web), so no dart:io adapter either.
bool usesDartIoHttpClient(HttpClientAdapter adapter) => false;
