/** SDK layer entry point (SPEC §5.3, wire protocol §6.1). */
import type { CreateSdkLayerOptions, SdkLayer } from '../types';
import { createSdkLayerWithTimings } from './layer';

export { createSdkLayerWithTimings } from './layer';
export { DEFAULT_SDK_TIMINGS, type SdkTimings } from './connection';
export { NdjsonDecoder, encodeNdjson } from './ndjson';

export function createSdkLayer(opts: CreateSdkLayerOptions): SdkLayer {
  return createSdkLayerWithTimings(opts);
}
