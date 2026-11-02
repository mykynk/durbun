/** Trigger a browser download for a URL (server sets Content-Disposition when it can). */
export function downloadUrl(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Save a Blob as a file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    downloadUrl(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Save text (e.g. exported logs) as a file. */
export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** Open a native file picker; resolves with the chosen files (empty when cancelled). */
export function pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    input.multiple = Boolean(opts.multiple);
    input.style.display = 'none';
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(input.files ? [...input.files] : []));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
