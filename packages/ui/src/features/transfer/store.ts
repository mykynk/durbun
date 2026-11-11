import { create } from 'zustand';
import type { PackageKind } from '@durbun/protocol';

/** Which package dialog is open (they live outside the tabs: the top bar, the settings and a drop open them). */
export type TransferDialog =
  | { kind: 'export'; mode: PackageKind; flows?: string[] }
  /** `text`: a package already read (a dropped file, a backup from the folder); null lets the user pick one. */
  | { kind: 'import'; text: string | null; fileName?: string }
  | null;

export const useTransfer = create<{ dialog: TransferDialog }>()(() => ({ dialog: null }));

export const transfer = {
  openExport(mode: PackageKind = 'share', flows?: string[]): void {
    useTransfer.setState({ dialog: { kind: 'export', mode, ...(flows ? { flows } : {}) } });
  },
  openImport(text: string | null = null, fileName?: string): void {
    useTransfer.setState({ dialog: { kind: 'import', text, ...(fileName ? { fileName } : {}) } });
  },
  close(): void {
    useTransfer.setState({ dialog: null });
  },
};

export type DurbunFileKind = 'package' | 'flow' | 'session' | 'unknown';

/** File types the flow pickers take: flow files, AI answers (Markdown / text) and packages. */
export const FLOW_FILE_ACCEPT = '.json,.durbun,.md,.txt,application/json,text/plain,text/markdown';

/**
 * Reads picked files and sets a Dürbün package apart: it opens in the package dialog, which also brings its
 * environments, mocks and settings. Only the first package counts; other packages are dropped with the rest.
 */
export async function readPicked(files: readonly File[]): Promise<{ pkg?: { text: string; name: string }; texts: string[] }> {
  const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
  const isPkg = (r: { text: string }) => sniffFormat(r.text.slice(0, 64 * 1024)) === 'package';
  const pkg = read.find(isPkg);
  return { ...(pkg ? { pkg } : {}), texts: read.filter((r) => !isPkg(r)).map((r) => r.text) };
}

/** What a Dürbün file is, from its first bytes (the `format` key comes first in every Dürbün file). */
export function sniffFormat(head: string): DurbunFileKind {
  const m = /"format"\s*:\s*"(durbun-[a-z]+)"/.exec(head);
  if (m?.[1] === 'durbun-package') return 'package';
  if (m?.[1] === 'durbun-flow') return 'flow';
  if (m?.[1] === 'durbun-session') return 'session';
  return 'unknown';
}
