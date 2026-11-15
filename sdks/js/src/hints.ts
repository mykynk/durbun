/**
 * The one-time console note printed when no Dürbün has accepted the app a while after `start()`: which
 * addresses were tried and what to do for this kind of device.
 */
import type { Runtime } from './env.js';
import type { DeviceHints } from './protocol.js';

const LAN_SETTING = 'Settings → Allow local network (Wi-Fi) connections';

function hostOf(url: string): string {
  const m = /^wss?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(url);
  return m ? m[1].replace(/^\[|\]$/g, '') : '';
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|10\.0\.2\.2)$/i;

export interface HintInput {
  runtime: Runtime;
  device: Partial<DeviceHints>;
  /** The addresses tried (resolved candidate URLs). */
  urls: readonly string[];
  /** A candidate that accepted the WebSocket but never completed the handshake. */
  openedUrl?: string;
  /** The app passed `host` / `url` itself. */
  explicitHost: boolean;
}

/** The note's lines (without the "[Dürbün]" prefix on the following lines). */
export function connectionHint(input: HintInput): string {
  const lines: string[] = [];
  lines.push(`[Dürbün] Not connected to Dürbün yet. Tried ${input.urls.join(', ')}.`);
  if (input.openedUrl) {
    lines.push(
      `${input.openedUrl} accepted the connection but did not answer like Dürbün: another program may be using that port, or that Dürbün is outdated.`,
    );
  }
  const remoteHosts = input.urls.map(hostOf).filter((h) => h && !LOOPBACK.test(h));
  const lanAddress = input.explicitHost && remoteHosts.length > 0 ? remoteHosts[0] : undefined;
  const passHost = lanAddress
    ? `check that ${lanAddress} is still the Mac's address (System Settings → Network)`
    : "pass the Mac's IP address (System Settings → Network): Durbun.start({ host: '192.168.1.20' })";
  const { platform, isPhysical } = input.device;

  if (input.runtime === 'react-native' && platform === 'android') {
    lines.push(
      'Android: open Dürbün on the Mac and connect the device over USB (or start the emulator). Dürbün forwards port 9750 to it by itself; `adb reverse --list` then shows tcp:9750.',
      `Over Wi-Fi without USB: turn on ${LAN_SETTING} in Dürbün, keep both on the same network and ${passHost}.`,
    );
  } else if (input.runtime === 'react-native' && platform === 'ios' && isPhysical === false) {
    lines.push('iOS Simulator: open Dürbün on this Mac; the simulator reaches it at localhost:9750.');
  } else if (input.runtime === 'react-native' && platform === 'ios') {
    lines.push(
      `iPhone: it reaches the Mac only over Wi-Fi. Turn on ${LAN_SETTING} in Dürbün, keep the phone and the Mac on the same network, ${passHost}, and allow the Local Network prompt (iPhone Settings → Privacy & Security → Local Network).`,
    );
    if (isPhysical === undefined) lines.push('On the iOS Simulator, opening Dürbün on this Mac is enough.');
  } else if (lanAddress) {
    lines.push(`Open Dürbün on the computer at ${lanAddress} with ${LAN_SETTING} turned on.`);
  } else {
    lines.push('Open Dürbün on this computer (it listens on localhost:9750), or pass Durbun.start({ host }) for another machine.');
  }
  lines.push('Durbun.start({ debug: true }) prints every attempt. This note is shown once; the SDK keeps retrying.');
  return lines.join('\n');
}
