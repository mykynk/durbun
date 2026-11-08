// Dio with an adapter that bypasses dart:io (here a stand-in for
// native_dio_adapter's NativeAdapter / cronet_http) reported to Dürbün.
//
// In a real app: `dio.httpClientAdapter = NativeAdapter();` and start the SDK
// with `Durbun.run` / `Durbun.init` as described in package:durbun.
import 'package:dio/dio.dart';
import 'package:durbun/durbun.dart';
import 'package:durbun_dio/durbun_dio.dart';
import 'package:flutter/widgets.dart';

Future<void> main() async {
  await Durbun.run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
    // dio.httpClientAdapter = NativeAdapter();
    dio.interceptors
      ..add(LogInterceptor())
      // Last: the request is reported as the interceptors before it left it.
      ..add(DurbunDioInterceptor(dio: dio));
    try {
      await dio.get<Object?>('/users');
    } on DioException catch (e) {
      Durbun.w('request failed', error: e);
    }
  });
}
