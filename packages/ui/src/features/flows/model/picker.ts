/** The step picker's search ranking and the "does this step run on the flow's device?" check. */
import { DEVICE_ACTION_SUPPORT, FLOW_NODE_GROUPS, type DeviceKind, type DevicePlatform, type FlowNodeSpec } from '@durbun/protocol';
import { fold } from '../../../lib/fuzzy';
import type { Lang } from '../../../i18n/core';
import { nodeDescription, nodeTitle } from './text';

/** Search keywords besides the titles, so "deep link", "screenshot", "bekle" find the right step in both languages. */
export const EXTRA_KEYWORDS: Record<string, string> = {
  'http.request': 'api endpoint get post put delete istek request',
  'wait.network': 'request istek api response yanıt',
  'logic.condition': 'if else eğer koşul branch dal',
  'logic.repeat': 'loop döngü poll tekrar foreach liste',
  'check.assert': 'assert expect doğrula kontrol test',
  'device.openUrl': 'deep link bağlantı url',
  'device.screenshot': 'ekran görüntüsü capture evidence kanıt',
  'device.startRecording': 'video kayıt record',
  'device.permission': 'izin permission kamera camera konum location bildirim notification grant revoke',
  'device.appLanguage': 'dil language locale yerel çeviri translation',
  'device.airplaneMode': 'uçak airplane offline çevrimdışı internet',
  'device.wifi': 'wifi kablosuz internet offline çevrimdışı',
  'device.mobileData': 'mobil veri hücresel cellular internet offline',
  'device.rotation': 'döndür rotate yatay dikey landscape portrait orientation',
  'device.dontKeepActivities': 'activity etkinlik state durum geliştirici developer process death',
  'mock.add': 'fake sahte stub',
  'output.slack': 'mesaj message bildirim',
  'flow.call': 'sub-flow alt akış call reuse',
};

/**
 * How well a step matches the search (lower is better), or null for no match. The title counts most: typing
 * "kontrol" must put "Kontrol et" before "Koşul", whose description merely mentions checking.
 */
export function stepScore(s: FlowNodeSpec, query: string, lang: Lang): number | null {
  const q = fold(query.trim());
  if (!q) return 0;
  const words = q.split(/\s+/);
  const title = fold(nodeTitle(s.type, lang));
  const other = fold(`${s.title} ${s.type} ${EXTRA_KEYWORDS[s.type] ?? ''}`);
  const desc = fold(nodeDescription(s.type, lang));
  if (!words.every((w) => title.includes(w) || other.includes(w) || desc.includes(w))) return null;
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  const titleWords = title.split(/[\s/()·,-]+/);
  if (words.every((w) => titleWords.some((tw) => tw.startsWith(w)))) return 2;
  if (words.every((w) => title.includes(w))) return 3;
  if (words.every((w) => title.includes(w) || other.includes(w))) return 4;
  return 5;
}

/** Steps for the picker: catalog order (by group) without a search, best match first with one. */
export function rankSteps(specs: readonly FlowNodeSpec[], query: string, lang: Lang): FlowNodeSpec[] {
  const groupIndex = (s: FlowNodeSpec) => FLOW_NODE_GROUPS.indexOf(s.group);
  const scored: { s: FlowNodeSpec; score: number; i: number }[] = [];
  specs.forEach((s, i) => {
    const score = stepScore(s, query, lang);
    if (score !== null) scored.push({ s, score, i });
  });
  const searching = !!query.trim();
  scored.sort((a, b) => (searching ? a.score - b.score : 0) || groupIndex(a.s) - groupIndex(b.s) || a.i - b.i);
  return scored.map((x) => x.s);
}

/** The device a flow runs on, as far as it is known (the picked or resolved target, else the flow's platform). */
export interface PickerTarget {
  platform: DevicePlatform;
  /** Unknown when only the flow's platform is known. */
  kind?: DeviceKind | string;
  /** Shown in the hint ("Pixel 8", "iPhone"). */
  name: string;
}

export type SupportPlace = 'android' | 'androidEmulator' | 'iosSimulator' | 'iosDevice';

/**
 * Whether a step can run on the target. A step that is not a device action always can. `where` lists the places it
 * does run, for the tag shown on a step that cannot run here.
 */
export function stepSupport(s: FlowNodeSpec, target: PickerTarget | null): { ok: boolean; where: SupportPlace[] } {
  const action = s.needs?.deviceAction;
  const sup = action ? DEVICE_ACTION_SUPPORT[action] : undefined;
  if (!sup || !target) return { ok: true, where: [] };
  const where: SupportPlace[] = [];
  if (sup.android === 'all') where.push('android');
  else if (sup.android === 'emulator') where.push('androidEmulator');
  if (sup.iosSimulator) where.push('iosSimulator');
  if (sup.iosDevice) where.push('iosDevice');
  let ok: boolean;
  if (target.platform === 'android') ok = sup.android === 'all' || (sup.android === 'emulator' && (target.kind === undefined || target.kind === 'emulator'));
  else if (target.kind === 'physical') ok = sup.iosDevice;
  else if (target.kind === undefined) ok = sup.iosDevice || sup.iosSimulator;
  else ok = sup.iosSimulator;
  return { ok, where };
}
