/**
 * Every screenshot and recording kept on this Mac, from every device (also the ones not plugged in now): filter
 * by device and type, grouped by day, the keeping rule, delete a device's whole set (with undo).
 */
import { useMemo, useState } from 'react';
import { Images, Trash } from 'lucide-react';
import { create } from 'zustand';
import type { MediaKind } from '@durbun/protocol';
import { Button, Dialog, EmptyState, SegmentedControl, Select, confirm, formatBytes } from '../../../components';
import { useT } from '../../../i18n';
import { groupByDay } from './format';
import { GalleryStatus, MediaGrid, PolicyNote, useDeviceMedia } from './Gallery';
import { deleteMedia } from './store';

/** How many tiles render before "Show more" (a library may hold up to a thousand items). */
const PAGE = 120;

export const useLibraryDialog = create<{ open: boolean; deviceId?: string; kind: MediaKind | 'all' }>()(() => ({ open: false, kind: 'all' }));

export function openLibrary(opts: { deviceId?: string; kind?: MediaKind | 'all' } = {}): void {
  useLibraryDialog.setState({ open: true, deviceId: opts.deviceId, kind: opts.kind ?? 'all' });
}

export function LibraryDialog() {
  const t = useT();
  const { open, deviceId, kind } = useLibraryDialog();
  const all = useDeviceMedia(undefined);
  const [limit, setLimit] = useState(PAGE);
  const devices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of all.items) if (!seen.has(i.deviceId)) seen.set(i.deviceId, i.deviceName || i.deviceId);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [all.items]);
  const items = useMemo(() => all.items.filter((i) => (!deviceId || i.deviceId === deviceId) && (kind === 'all' || i.kind === kind)), [all.items, deviceId, kind]);
  const groups = useMemo(() => groupByDay(items.slice(0, limit)), [items, limit]);
  const deviceName = deviceId ? devices.find((d) => d.value === deviceId)?.label ?? deviceId : undefined;
  const deviceItems = deviceId ? all.items.filter((i) => i.deviceId === deviceId) : [];

  const removeDevice = async () => {
    if (!deviceId || !deviceItems.length) return;
    const ok = await confirm({
      title: t('media.deleteDeviceTitle', { count: deviceItems.length, device: deviceName ?? deviceId }),
      message: t('media.deleteDeviceBody'),
      confirmLabel: t('media.deleteConfirm'),
      danger: true,
    });
    if (ok) deleteMedia(deviceItems.map((i) => i.id), { deviceId });
  };

  return (
    <Dialog
      open={open}
      onClose={() => useLibraryDialog.setState({ open: false })}
      size="xl"
      icon={Images}
      title={t('media.library')}
      description={
        all.total > 0 ? `${t('media.libraryDesc')} · ${t('media.used', { count: all.total, size: formatBytes(all.usedBytes) })}` : t('media.libraryDesc')
      }
      autoFocusField={false}
      footer={
        <>
          {deviceId && deviceItems.length ? (
            <Button variant="ghost" icon={Trash} onClick={() => void removeDevice()}>
              {t('media.deleteDevice')}
            </Button>
          ) : null}
          <span className="grow" />
          <Button onClick={() => useLibraryDialog.setState({ open: false })}>{t('common.close')}</Button>
        </>
      }
    >
      <div className="md-lib">
        <div className="md-lib__bar">
          {devices.length > 1 || deviceId ? (
            <Select
              size="sm"
              aria-label={t('media.deviceFilter')}
              value={deviceId ?? ''}
              onChange={(e) => {
                setLimit(PAGE);
                useLibraryDialog.setState({ deviceId: e.target.value || undefined });
              }}
              options={[{ value: '', label: t('media.allDevices') }, ...devices]}
            />
          ) : null}
          <SegmentedControl
            size="sm"
            aria-label={t('media.library')}
            value={kind}
            onChange={(v) => {
              setLimit(PAGE);
              useLibraryDialog.setState({ kind: v });
            }}
            options={[
              { value: 'all', label: t('media.kind.all') },
              { value: 'screenshot', label: t('media.kind.screenshot') },
              { value: 'recording', label: t('media.kind.recording') },
            ]}
          />
          <span className="grow" />
          <PolicyNote policy={all.policy} />
        </div>
        <GalleryStatus status={all.status} error={all.error} hasItems={all.items.length > 0}>
          {all.items.length === 0 ? (
            <EmptyState icon={Images} title={t('media.emptyAll')} description={t('media.emptyAllHint', { days: all.policy?.maxAgeDays ?? 30 })} />
          ) : items.length === 0 ? (
            <EmptyState icon={Images} size="sm" title={t('media.emptyFilter')} description={t('media.emptyFilterHint')} />
          ) : (
            <div className="md-lib__groups">
              {groups.map((g) => (
                <section key={g.key} className="md-lib__group" aria-label={g.label}>
                  <h3 className="md-lib__day">
                    {g.label} <span className="subtle tnum">· {g.items.length}</span>
                  </h3>
                  <MediaGrid items={g.items} label={g.label} showDevice={!deviceId} timeOnly wide />
                </section>
              ))}
              {items.length > limit ? (
                <Button size="sm" variant="subtle" className="md-lib__more" onClick={() => setLimit(items.length)}>
                  {t('media.showAll', { count: items.length })}
                </Button>
              ) : null}
            </div>
          )}
        </GalleryStatus>
      </div>
    </Dialog>
  );
}
