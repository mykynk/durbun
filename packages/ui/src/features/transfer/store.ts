import { create } from 'zustand';
import type { PackageKind } from '@durbun/protocol';

/** Which package dialog is open (they live outside the tabs: the top bar, the settings and a drop open them). */
export type TransferDialog =
  /** `runs`: exactly these runs go with the flows (a set run's report); `name`: the package name to start with. */
  | { kind: 'export'; mode: PackageKind; flows?: string[]; runs?: string[]; name?: string }
  /** `text`: a package already read (a dropped file, a backup from the folder); null lets the user pick one. */
  | { kind: 'import'; text: string | null; fileName?: string }
  /** Session recording / HAR export: what goes in, masked or not. `ids`: fixed requests (the Network tab's HAR). */
  | { kind: 'data'; format: DataExportFormat; ids?: string[]; label?: string; fileName?: string }
  | null;

export type DataExportFormat = 'session' | 'har';

export const useTransfer = create<{ dialog: TransferDialog }>()(() => ({ dialog: null }));

export const transfer = {
  openExport(mode: PackageKind = 'share', flows?: string[], preset: { runs?: string[]; name?: string } = {}): void {
    useTransfer.setState({ dialog: { kind: 'export', mode, ...(flows ? { flows } : {}), ...(preset.runs ? { runs: preset.runs } : {}), ...(preset.name ? { name: preset.name } : {}) } });
  },
  openImport(text: string | null = null, fileName?: string): void {
    useTransfer.setState({ dialog: { kind: 'import', text, ...(fileName ? { fileName } : {}) } });
  },
  /**
   * The export dialog for a session recording or a HAR (masked by default). Without `ids` the user picks the scope;
   * with `ids` (visible rows, one request) the HAR holds exactly those, named by `label`.
   */
  openDataExport(format: DataExportFormat, fixed?: { ids: string[]; label: string; fileName?: string }): void {
    useTransfer.setState({ dialog: { kind: 'data', format, ...(fixed ? { ids: fixed.ids, label: fixed.label, ...(fixed.fileName ? { fileName: fixed.fileName } : {}) } : {}) } });
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
