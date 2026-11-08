/**
 * build/icon.svg → build/icon.png (1024 × 1024, transparent corners), the Mac app icon electron-builder
 * turns into the .icns. Run after changing the SVG:  npx electron scripts/render-icon.cjs
 * The SVG follows Apple's icon grid: an 824-point rounded square centred on the 1024 canvas with the shadow
 * in the margin, so Dürbün sits at the same size as the other apps in the Dock and Finder.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
const html = `<!doctype html><html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:transparent">` +
  `<img style="display:block" width="${SIZE}" height="${SIZE}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = (await win.webContents.capturePage()).resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.toPNG());
  app.quit();
});
