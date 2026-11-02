import type { ReactNode } from 'react';
import { Hammer } from 'lucide-react';
import { useT } from '../i18n';
import type { IconType } from '../components/Icons';

/** Placeholder used by phase-2 feature folders until their real views land. */
export function ComingSoon({ icon: Icon, title, description, features, stat }: { icon: IconType; title: string; description: string; features: string[]; stat?: ReactNode }) {
  const t = useT();
  return (
    <div className="coming-soon">
      <div className="coming-soon__card">
        <div className="coming-soon__icon">
          <Icon size={22} aria-hidden />
        </div>
        <span className="coming-soon__badge">
          <Hammer size={11} aria-hidden />
          {t('shell.placeholder.badge')}
        </span>
        <h2 className="coming-soon__title">{title}</h2>
        <p className="coming-soon__desc">{description}</p>
        <ul className="coming-soon__list">
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        {stat ? <div className="coming-soon__stat">{stat}</div> : null}
      </div>
    </div>
  );
}
