import { useEffect, useRef, useState } from 'react';
import { useLanguage, useT } from '../../i18n';
import type { DeviceSectionId } from './model';

/** Fewer cards than this fit on one screen: the strip would only add noise. */
export const JUMP_STRIP_MIN = 4;

/**
 * The cards this device shows, as one chip each, sticky under the device header: a click (or Enter) scrolls to the
 * card and moves focus to its heading. Scrolls sideways when the chips do not fit, with a fade on the side that has more.
 */
export function JumpStrip({ sections, onJump }: { sections: readonly DeviceSectionId[]; onJump: (section: DeviceSectionId) => void }) {
  const t = useT();
  const lang = useLanguage();
  const trackRef = useRef<HTMLUListElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const shown = sections.join('|');

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [shown, lang]);

  return (
    <nav className="dv-jump" aria-label={t('device.jump.label')}>
      <div className="dv-jump__inner" data-fade-start={fade.start || undefined} data-fade-end={fade.end || undefined}>
        <ul ref={trackRef} className="dv-jump__track">
          {sections.map((section) => (
            <li key={section}>
              <button type="button" className="chip chip--neutral chip--md chip--clickable dv-jump__chip" onClick={() => onJump(section)}>
                <span className="chip__label">{t(`device.jump.${section}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
