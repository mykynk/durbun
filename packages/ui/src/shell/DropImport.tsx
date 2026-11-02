import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useT } from '../i18n';
import { Portal } from '../components/floating';
import { importFile } from './actions';

function hasFiles(e: DragEvent): boolean {
  return Boolean(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
}

/** Feature drop zones mark themselves with `data-dropzone` (e.g. app install); the global import skips them. */
function inFeatureZone(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-dropzone]'));
}

/** Window-wide drag-and-drop import of `.durbun.json` session files. */
export function DropImport() {
  const t = useT();
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setActive(!inFeatureZone(e.target));
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (inFeatureZone(e.target)) {
        setActive(false);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setActive(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!hasFiles(e) || inFeatureZone(e.target)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) void importFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!active) return null;
  return (
    <Portal>
      <div className="drop-overlay" aria-hidden>
        <div className="drop-overlay__box">
          <FileUp size={26} />
          <div className="drop-overlay__title">{t('shell.io.dropTitle')}</div>
          <div className="drop-overlay__hint">{t('shell.io.dropHintLong')}</div>
        </div>
      </div>
    </Portal>
  );
}
