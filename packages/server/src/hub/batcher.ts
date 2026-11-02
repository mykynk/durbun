/**
 * Change batching: everything the hub changes is queued here and flushed to subscribers every
 * `intervalMs` (or immediately once `maxQueuedLogs` logs are waiting). Network entries, devices, apps and
 * processes are coalesced by id (latest state wins); logs and metric samples are delivered in order.
 */
import type { AppSession, DeviceInfo, LogEntry, MetricSample, NetworkEntry, ProcessUpdate } from '@durbun/protocol';
import type { HubChange, Logger } from '../types';

/** A single HubChange never carries more logs than this (huge imports are split). */
export const MAX_LOGS_PER_CHANGE = 5000;

export class ChangeBatcher {
  private logs: LogEntry[] = [];
  private network = new Map<string, NetworkEntry>();
  private devices = new Map<string, DeviceInfo>();
  private removedDevices = new Set<string>();
  private apps = new Map<string, AppSession>();
  private metrics: MetricSample[] = [];
  private processes = new Map<string, ProcessUpdate>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private disposed = false;
  private readonly listeners = new Set<(change: HubChange) => void>();

  constructor(
    private readonly intervalMs: number,
    private readonly maxQueuedLogs: number,
    private readonly logger: Logger,
  ) {}

  get queuedLogs(): number {
    return this.logs.length;
  }

  subscribe(listener: (change: HubChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  addLogs(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    if (entries.length === 1) this.logs.push(entries[0]!);
    else for (const e of entries) this.logs.push(e);
    if (this.logs.length >= this.maxQueuedLogs) this.flush();
    else this.schedule();
  }

  networkChanged(entry: NetworkEntry): void {
    this.network.set(entry.id, entry);
    this.schedule();
  }

  deviceChanged(device: DeviceInfo): void {
    this.removedDevices.delete(device.id);
    this.devices.set(device.id, device);
    this.schedule();
  }

  deviceRemoved(id: string): void {
    this.devices.delete(id);
    this.removedDevices.add(id);
    this.schedule();
  }

  appChanged(app: AppSession): void {
    this.apps.set(app.id, app);
    this.schedule();
  }

  metricsAdded(samples: MetricSample[]): void {
    if (samples.length === 0) return;
    for (const s of samples) this.metrics.push(s);
    this.schedule();
  }

  processChanged(update: ProcessUpdate): void {
    this.processes.set(`${update.deviceId}\u0000${update.pid}`, update);
    this.schedule();
  }

  /** Delivers everything queued right now (no-op when empty or while already flushing). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing || this.disposed || this.isEmpty()) return;
    this.flushing = true;
    try {
      const logs = this.logs;
      const change: HubChange = {
        logs: [],
        network: [...this.network.values()].map((e) => ({ ...e })),
        devices: [...this.devices.values()].map((d) => ({ ...d })),
        removedDevices: [...this.removedDevices],
        apps: [...this.apps.values()].map((a) => ({ ...a, stats: { ...a.stats } })),
        metrics: this.metrics,
        processes: [...this.processes.values()],
      };
      this.logs = [];
      this.network = new Map();
      this.devices = new Map();
      this.removedDevices = new Set();
      this.apps = new Map();
      this.metrics = [];
      this.processes = new Map();

      if (logs.length <= MAX_LOGS_PER_CHANGE) {
        change.logs = logs;
        this.emit(change);
      } else {
        change.logs = logs.slice(0, MAX_LOGS_PER_CHANGE);
        this.emit(change);
        for (let i = MAX_LOGS_PER_CHANGE; i < logs.length; i += MAX_LOGS_PER_CHANGE) {
          this.emit({
            logs: logs.slice(i, i + MAX_LOGS_PER_CHANGE),
            network: [],
            devices: [],
            removedDevices: [],
            apps: [],
            metrics: [],
            processes: [],
          });
        }
      }
    } finally {
      this.flushing = false;
    }
    // Changes queued by listeners during the flush go out with the next tick.
    if (!this.isEmpty()) this.schedule();
  }

  /** Drops everything queued (used before a clear, after flushing). */
  discard(): void {
    this.logs = [];
    this.network.clear();
    this.devices.clear();
    this.removedDevices.clear();
    this.apps.clear();
    this.metrics = [];
    this.processes.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.discard();
    this.listeners.clear();
  }

  private isEmpty(): boolean {
    return (
      this.logs.length === 0 &&
      this.network.size === 0 &&
      this.devices.size === 0 &&
      this.removedDevices.size === 0 &&
      this.apps.size === 0 &&
      this.metrics.length === 0 &&
      this.processes.size === 0
    );
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private emit(change: HubChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        this.logger.warn('hub subscriber failed', err);
      }
    }
  }
}
