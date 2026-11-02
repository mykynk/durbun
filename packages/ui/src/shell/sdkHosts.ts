import { DEFAULT_PORTS } from '@durbun/protocol';
import { androidWifi, flutterWifi, iosWifi, rnWifi } from './sdkSnippets';

export type SdkHostTarget = 'flutter' | 'android' | 'ios' | 'react-native';

export interface SdkHostLine {
  sdk: SdkHostTarget;
  /** What to put in the app so it reaches this Mac over Wi-Fi (exact SDK APIs). */
  code: string;
}

/**
 * Wi-Fi setup line per SDK for a desktop address. The native SDKs talk to the SDK port (TCP); React Native
 * uses the HTTP port (`ws://<host>:<http>/sdk`). Non-default ports are spelled out.
 */
export function sdkHostLines(host: string, ports: { http: number; sdk: number } = DEFAULT_PORTS): SdkHostLine[] {
  const sdkPort = ports.sdk !== DEFAULT_PORTS.sdk ? ports.sdk : undefined;
  const httpPort = ports.http !== DEFAULT_PORTS.http ? ports.http : undefined;
  return [
    { sdk: 'flutter', code: flutterWifi(host, sdkPort) },
    { sdk: 'android', code: androidWifi(host, sdkPort) },
    { sdk: 'ios', code: iosWifi(host, sdkPort) },
    { sdk: 'react-native', code: rnWifi(host, httpPort) },
  ];
}
