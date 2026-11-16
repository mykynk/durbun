/**
 * The iPhone side of "Full device report": iOS's own sysdiagnose is started from the phone's buttons and saved on
 * the phone, so this card only says how (no button). Shown by data/explain.ts `showsIphoneReportGuide`.
 */
import { FileArchive } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { useT } from '../../i18n';
import { DeviceCard } from './useAction';
import './i18nAppData';

const STEPS = ['press', 'wait', 'find', 'share'] as const;

export function IphoneReportCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  return (
    <DeviceCard section="bug-report" title={t('device.iphoneReport.title')} icon={FileArchive} description={t('device.iphoneReport.hint')}>
      <ol className="dv-steps" aria-label={t('device.iphoneReport.stepsLabel', { device: device.name })}>
        {STEPS.map((s) => (
          <li key={s}>{t(`device.iphoneReport.steps.${s}`)}</li>
        ))}
      </ol>
      <p className="dv-hint">{t('device.iphoneReport.note')}</p>
    </DeviceCard>
  );
}
