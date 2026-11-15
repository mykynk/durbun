/**
 * Mac app: Dürbün files opened from Finder (double click, Open With, a drop on the Dock icon) or File →
 * Open… go through the same import as a file dropped on the window (importFile). The app sends the
 * 'open-file' command when files wait (apps/desktop openFiles.ts); the page also asks once when it loads,
 * for files that started the app. Outside the Mac app there is no bridge and this does nothing.
 */
import { importFile } from './actions';

interface OpenedFilesBridge {
  takeOpenedFiles?: () => Promise<{ name: string; text: string }[]>;
}

let queue: Promise<void> = Promise.resolve();

function takeAndImport(): void {
  const bridge = (window as unknown as { durbunDesktop?: OpenedFilesBridge }).durbunDesktop;
  const take = bridge?.takeOpenedFiles;
  if (typeof take !== 'function') return;
  // One file after the other: each import may ask a question (a package) or switch the scope (a session).
  queue = queue.then(async () => {
    const files = await take().catch(() => []);
    for (const f of files) await importFile(new File([f.text], f.name, { type: 'application/json' }));
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('durbun:command', (e) => {
    if ((e as CustomEvent<unknown>).detail === 'open-file') takeAndImport();
  });
  takeAndImport();
}
