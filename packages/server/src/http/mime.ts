/** Content types for static UI files and files in the temp directory. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.har': 'application/json; charset=utf-8',
};

export function mimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[lower.slice(dot)] ?? 'application/octet-stream';
}

/** Content types a browser could execute or render as a document — served sandboxed. */
export function isActiveContent(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes('html') || ct.includes('svg') || ct.includes('xml') || ct.includes('javascript');
}

const EXTENSIONS: [RegExp, string][] = [
  [/json/, 'json'],
  [/html/, 'html'],
  [/svg/, 'svg'],
  [/xml/, 'xml'],
  [/javascript/, 'js'],
  [/css/, 'css'],
  [/png/, 'png'],
  [/jpe?g/, 'jpg'],
  [/gif/, 'gif'],
  [/webp/, 'webp'],
  [/avif/, 'avif'],
  [/pdf/, 'pdf'],
  [/protobuf/, 'pb'],
  [/x-www-form-urlencoded/, 'txt'],
  [/graphql/, 'graphql'],
  [/csv/, 'csv'],
  [/^text\//, 'txt'],
  [/mp4/, 'mp4'],
  [/zip/, 'zip'],
];

/** File extension (without dot) for a content type, 'bin' when unknown. */
export function extensionFor(contentType: string | undefined): string {
  if (!contentType) return 'bin';
  const ct = contentType.toLowerCase();
  for (const [re, ext] of EXTENSIONS) if (re.test(ct)) return ext;
  return 'bin';
}
