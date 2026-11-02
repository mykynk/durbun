import { create } from 'zustand';
import type { ServerInfo } from '@durbun/protocol';

/**
 * connecting   – first attempt in progress
 * syncing      – socket open, hello received, snapshot/history still loading
 * live         – history done; live batches flowing
 * reconnecting – connection lost (or never established); a retry is scheduled
 */
export type ConnectionStatus = 'connecting' | 'syncing' | 'live' | 'reconnecting';

export interface ConnectionState {
  status: ConnectionStatus;
  server: ServerInfo | null;
  /** At least one connection reached `hello` since page load. */
  everConnected: boolean;
  /** Consecutive failed attempts (0 while connected). */
  attempt: number;
  /** When the next retry fires (epoch ms) while reconnecting. */
  nextRetryAt: number | null;
  lastError: string | null;
  connectedAt: number | null;
  /** Number of log entries the server announced in the snapshot (history progress). */
  expectedLogCount: number;
  /** Log entries received through history so far. */
  historyReceived: number;
  /** Server speaks a different protocol version. */
  protocolMismatch: boolean;
}

export const useConnection = create<ConnectionState>()(() => ({
  status: 'connecting',
  server: null,
  everConnected: false,
  attempt: 0,
  nextRetryAt: null,
  lastError: null,
  connectedAt: null,
  expectedLogCount: 0,
  historyReceived: 0,
  protocolMismatch: false,
}));

export function isConnected(status: ConnectionStatus): boolean {
  return status === 'syncing' || status === 'live';
}
