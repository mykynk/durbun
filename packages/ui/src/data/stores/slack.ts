import { useEffect } from 'react';
import { create } from 'zustand';
import * as api from '../api';

/* ───────────── Send to Slack ───────────── */

export interface SlackState {
  /** null until the first answer (or when the server could not be asked). */
  status: api.SlackStatus | null;
}

export const useSlack = create<SlackState>()(() => ({ status: null }));

let pending: Promise<api.SlackStatus | null> | null = null;

/** Asks the server again (the webhook may have changed in another window or by hand). */
export function loadSlack(): Promise<api.SlackStatus | null> {
  pending ??= api
    .slackStatus()
    .then(
      (status) => {
        useSlack.setState({ status });
        return status;
      },
      () => null,
    )
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The Slack connection, refreshed whenever a component using it mounts. */
export function useSlackStatus(): api.SlackStatus | null {
  useEffect(() => {
    void loadSlack();
  }, []);
  return useSlack((s) => s.status);
}

export async function updateSlack(patch: { webhookUrl?: string | null; sender?: string | null }): Promise<api.SlackStatus> {
  const status = await api.updateSlack(patch);
  useSlack.setState({ status });
  return status;
}
