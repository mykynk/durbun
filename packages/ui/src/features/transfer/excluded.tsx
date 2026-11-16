import './i18n';
import { clsx } from 'clsx';
import { useT, type TFunction } from '../../i18n';

/**
 * What a backup (the file and the automatic ones) leaves out, as message keys of short noun phrases in the UI's
 * words; the sentence lists them in this order. A store that stays out of backups adds its key here, with its
 * Turkish and English text.
 */
export const BACKUP_EXCLUDED: readonly string[] = ['transfer.backup.excludedItem.media', 'transfer.backup.excludedItem.sessions'];

/**
 * "Not in the backup: A, B." in the UI language. Items are joined with a comma in both languages (an item may hold
 * its own "and"; locale list formats differ between Node and the app's browser).
 */
export function backupExcludedText(t: TFunction, keys: readonly string[] = BACKUP_EXCLUDED): string {
  return t('transfer.backup.excluded', { items: keys.map((k) => t(k)).join(', ') });
}

/** The one plain sentence under the backup dialog's contents and in Settings → Backup. */
export function BackupExcluded({ className }: { className?: string }) {
  const t = useT();
  return <p className={clsx('tx-hint', 'tx-excluded', className)}>{backupExcludedText(t)}</p>;
}
