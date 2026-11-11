import { useEffect } from 'react';
import { create } from 'zustand';
import { FLOW_ENVIRONMENTS_FORMAT, type FlowEnvironment, type FlowEnvironments } from '@durbun/protocol';
import { api } from '../../../data';

/** Flow environments ("Ortamlar"): base URLs, keys and accounts flows read as {{env.<key>}}. */
interface EnvState {
  envs: FlowEnvironments | null;
}

export const useEnvStore = create<EnvState>()(() => ({ envs: null }));

let pending: Promise<FlowEnvironments | null> | null = null;

export function loadEnvironments(): Promise<FlowEnvironments | null> {
  pending ??= api
    .getFlowEnvironments()
    .then(
      (envs) => {
        useEnvStore.setState({ envs });
        return envs;
      },
      () => null,
    )
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Environments, refreshed when a component using them mounts. */
export function useEnvironments(): FlowEnvironments | null {
  useEffect(() => {
    void loadEnvironments();
  }, []);
  return useEnvStore((s) => s.envs);
}

export async function saveEnvironments(next: FlowEnvironments): Promise<FlowEnvironments> {
  const saved = await api.saveFlowEnvironments(next);
  useEnvStore.setState({ envs: saved });
  return saved;
}

export function emptyEnvironments(): FlowEnvironments {
  return { format: FLOW_ENVIRONMENTS_FORMAT, version: 1, environments: [] };
}

export function activeEnvironment(envs: FlowEnvironments | null): FlowEnvironment | undefined {
  if (!envs) return undefined;
  return envs.environments.find((e) => e.id === envs.activeId) ?? undefined;
}

export function newEnvId(envs: FlowEnvironments, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'env';
  const used = new Set(envs.environments.map((e) => e.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** "KEY=value" lines (a .env file, a wiki table copied as text) → variables. Secret-looking keys are marked secret. */
export function parseEnvText(text: string): { key: string; value: string; secret: boolean }[] {
  const out: { key: string; value: string; secret: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    const key = m[1]!.replace(/[.-]/g, '_');
    out.push({ key, value, secret: /(token|secret|password|passwd|pass|key|auth|cookie|session)/i.test(key) });
  }
  return out;
}
