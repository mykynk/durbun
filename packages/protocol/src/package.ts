/**
 * Dürbün packages (`.durbun` files): one JSON document that carries what a person set up in Dürbün — flows, mock
 * rules, environments, settings, UI preferences, the Slack connection, flow run history.
 *
 *   kind 'share'  for teammates: chosen items, never secrets (secret environment values are left empty).
 *   kind 'backup' for a new Mac: everything; secrets only when a passphrase encrypts them (AES-256-GCM, scrypt).
 *
 * There is no cloud: a package is a file the user moves (AirDrop, Slack, a synced folder).
 */
import type { MockRule, ServerSettings } from './index';
import type { FlowDoc, FlowEnvironments, FlowRun } from './flows/types';

export const PACKAGE_FORMAT = 'durbun-package';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.durbun';

export type PackageKind = 'share' | 'backup';

export interface PackageRunFile {
  name: string;
  contentType: string;
  /** base64 */
  data: string;
}

export interface PackageRun {
  run: FlowRun;
  files?: PackageRunFile[];
}

export interface DurbunPackageContents {
  flows?: FlowDoc[];
  mocks?: MockRule[];
  /** Secret values are empty here; a backup keeps them in `secrets`. */
  environments?: FlowEnvironments;
  /** Only the keys set on purpose (not the defaults). */
  settings?: Partial<ServerSettings>;
  /** The UI's own preferences (theme, language, noise rules…). */
  uiPrefs?: Record<string, unknown>;
  /** Sender name; the webhook itself is a secret. */
  slack?: { sender?: string; configured: boolean };
  runs?: PackageRun[];
  /**
   * flow id → names of its secret inputs whose default value was held back (a share leaves it out, a backup
   * keeps it only in `secrets.inputs`).
   */
  secretInputs?: Record<string, string[]>;
}

/** What the passphrase protects. */
export interface PackageSecrets {
  /** environment id → key → value */
  env?: Record<string, Record<string, string>>;
  slackWebhook?: string;
  /** flow id → secret input name → its default value */
  inputs?: Record<string, Record<string, string | number | boolean>>;
}

export interface EncryptedBlob {
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
  iv: string;
  tag: string;
  data: string;
  /**
   * 'contents-sha256': the SHA-256 of `JSON.stringify(contents)` is the GCM associated data, so the passphrase only
   * opens a package whose contents are unchanged. Blobs without it (older packages) bind nothing.
   */
  aad?: 'contents-sha256';
}

/** A coded message (warnings of inspect and import): `code` for the UI's text, English `message` as fallback. */
export interface PackageNotice {
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

/** Secret values that are empty after an import: environment variables, or default values of secret flow inputs. */
export interface PackageEmptySecret {
  kind: 'env' | 'input';
  /** Environment id or flow id. */
  id: string;
  /** Environment or flow name. */
  name: string;
  /** Variable keys or input names. */
  keys: string[];
}

export interface DurbunPackage {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  kind: PackageKind;
  createdAt: number;
  createdBy: { app: string; version: string; host?: string };
  /** Shown when importing ("Sipariş akışları", "Yusuf's MacBook backup"). */
  name?: string;
  note?: string;
  contents: DurbunPackageContents;
  secrets?: EncryptedBlob;
}

export interface PackageExportRequest {
  kind: PackageKind;
  name?: string;
  note?: string;
  include: {
    /** Flow ids, or 'all'. Flows they call come along. */
    flows?: string[] | 'all';
    mocks?: boolean | string[];
    environments?: boolean;
    settings?: boolean;
    uiPrefs?: boolean;
    slack?: boolean;
    /** true = every run; ids = those runs (with their screenshots and recordings). */
    runs?: boolean | string[];
  };
  /** Encrypts secrets into the package (backup only). Without it secrets stay out. */
  passphrase?: string;
  /** The UI's preferences to put in (the server keeps the last copy the UI synced otherwise). */
  uiPrefs?: Record<string, unknown>;
}

export interface PackageItemPreview {
  id: string;
  name: string;
  /** Something with this id already exists here (for mock rules: also an identical rule under another id). */
  exists: boolean;
  /** …and it differs. Identical items are skipped by every import. */
  differs?: boolean;
  /** A flow whose automation is on (a shared flow comes in with it off). */
  automation?: boolean;
}

export interface PackageManifest {
  kind: PackageKind;
  name?: string;
  note?: string;
  createdAt: number;
  createdBy: DurbunPackage['createdBy'];
  flows: PackageItemPreview[];
  mocks: PackageItemPreview[];
  environments: PackageItemPreview[];
  envVarCount: number;
  settings: boolean;
  uiPrefs: boolean;
  slack: boolean;
  runs: number;
  hasSecrets: boolean;
  /** Problems found while reading (invalid flows are listed with their issues). */
  warnings: { code: string; message: string; params?: Record<string, string | number> }[];
  /** Pass to POST /api/packages/import instead of sending the package again (valid for 30 minutes). */
  token?: string;
  /** The passphrase opens the secrets (when one was given to inspect). */
  passphraseOk?: boolean;
}

export type PackageConflict = 'replace' | 'keepBoth' | 'skip';

export interface PackageImportRequest {
  /** The package itself, or the `token` POST /api/packages/inspect returned for it (it keeps the file a while). */
  package?: DurbunPackage;
  token?: string;
  passphrase?: string;
  include: {
    flows?: string[] | 'all';
    mocks?: boolean;
    environments?: boolean;
    settings?: boolean;
    uiPrefs?: boolean;
    slack?: boolean;
    runs?: boolean;
  };
  /** Same id already here. */
  conflict: PackageConflict;
}

export interface PackageImportResult {
  /** `same`: identical to what is here, left alone whatever the conflict choice. */
  flows: { added: number; replaced: number; skipped: number; renamed: number; same?: number };
  mocks: { added: number; replaced: number; skipped: number; same?: number };
  environments: { added: number; replaced: number; skipped: number; same?: number };
  settings: boolean;
  slack: boolean;
  runs: number;
  /** Preferences the UI should apply. */
  uiPrefs?: Record<string, unknown>;
  secretsRestored: boolean;
  /** English texts of `notices` (older readers). */
  warnings: string[];
  /** The warnings with their codes, for the UI's own text. */
  notices?: PackageNotice[];
  /** Shared flows whose automation was switched off on the way in (turn it on again in the flow's settings). */
  automationOff?: number;
  /** Secret values that are empty here after the import. */
  emptySecrets?: PackageEmptySecret[];
}

export interface BackupSettings {
  enabled: boolean;
  /** Absolute folder path (iCloud Drive, Dropbox, an external disk…). */
  folder?: string;
  /** Newest backups kept in the folder. */
  keep: number;
  /** Hours between automatic backups (they also run after changes, at most once per hour). */
  intervalHours: number;
  includeRuns: boolean;
  /** A passphrase is stored on this Mac, so automatic backups include secrets (encrypted). */
  hasPassphrase: boolean;
  lastBackupAt?: number;
  lastBackupFile?: string;
  lastError?: string;
  /** The last backup was written, but old backups could not be removed: why (the system's English error). */
  lastWarning?: string;
}

export interface BackupSettingsPatch {
  enabled?: boolean;
  folder?: string | null;
  keep?: number;
  intervalHours?: number;
  includeRuns?: boolean;
  /** A new passphrase; null forgets it. */
  passphrase?: string | null;
}
