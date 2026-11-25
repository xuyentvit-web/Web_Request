// Renders public/icons/icon.svg to the PNG sizes the manifest and iOS need.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  for (const size of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    // iOS adds its own rounded corners, so the PNGs are full-bleed squares.
    await p.setContent(`<style>html,body{margin:0;background:#0d6b6e}</style>${svg.replace('rx="112"', 'rx="0"').replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
    await p.screenshot({ path: path.join(__dirname, '..', 'public', 'icons', `icon-${size}.png`) });
    await p.close();
  }
  await b.close();
})();
