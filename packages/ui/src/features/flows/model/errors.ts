import { ApiError } from '../../../data';
import { errorText } from '../../../i18n';
import { t } from '../../../i18n/core';

/**
 * An error for the Flows tab: a server that cannot be reached (network down, a proxy's 502/503/504) or a bare 5xx
 * gets a plain sentence instead of "502 Bad Gateway"; everything else is worded from its code.
 */
export function flowErrorText(err: unknown): string {
  if (err instanceof ApiError && !(err.code && err.code !== 'network')) {
    if (err.status === 0 || err.code === 'network' || err.status === 502 || err.status === 503 || err.status === 504) return t('flows.errors.unreachable');
    if (err.status >= 500) return t('flows.errors.server', { status: err.status });
  }
  return errorText(err);
}
