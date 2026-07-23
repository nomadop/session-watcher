#!/usr/bin/env node
/**
 * Generate pre-release image assets from SVG sources.
 * Run: node scripts/generate-assets.js
 * Requires: sharp (npm install --no-save sharp)
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = resolve(__dirname, '../public');

// ── Favicon PNG (32x32) ──
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4fe0b0"/>
      <stop offset="100%" stop-color="#2f9c7c"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="7" fill="url(#g)"/>
  <text x="16" y="21.5" font-family="system-ui,sans-serif" font-weight="700" font-size="12" fill="#052018" text-anchor="middle">SW</text>
</svg>`;

// ── Apple Touch Icon (180x180) ──
const touchIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4fe0b0"/>
      <stop offset="100%" stop-color="#2f9c7c"/>
    </linearGradient>
  </defs>
  <rect width="180" height="180" rx="36" fill="url(#g)"/>
  <text x="90" y="108" font-family="system-ui,sans-serif" font-weight="700" font-size="64" fill="#052018" text-anchor="middle">SW</text>
</svg>`;

// ── OG Image (1200x630) ──
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0e1114"/>
      <stop offset="100%" stop-color="#151b20"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4fe0b0"/>
      <stop offset="100%" stop-color="#2f9c7c"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- Subtle grid lines -->
  <g stroke="#232d35" stroke-width="1" opacity="0.4">
    <line x1="0" y1="157" x2="1200" y2="157"/>
    <line x1="0" y1="315" x2="1200" y2="315"/>
    <line x1="0" y1="473" x2="1200" y2="473"/>
    <line x1="300" y1="0" x2="300" y2="630"/>
    <line x1="600" y1="0" x2="600" y2="630"/>
    <line x1="900" y1="0" x2="900" y2="630"/>
  </g>
  <!-- Logo mark -->
  <rect x="80" y="245" width="56" height="56" rx="12" fill="url(#accent)"/>
  <text x="108" y="281" font-family="system-ui,sans-serif" font-weight="700" font-size="22" fill="#052018" text-anchor="middle">SW</text>
  <!-- Title -->
  <text x="160" y="267" font-family="system-ui,sans-serif" font-weight="700" font-size="48" fill="#eef3f6">Session Watcher</text>
  <!-- Subtitle -->
  <text x="160" y="310" font-family="system-ui,sans-serif" font-weight="400" font-size="22" fill="#93a1ab">Know when to restart your Claude Code session</text>
  <!-- Accent bar -->
  <rect x="80" y="580" width="1040" height="4" rx="2" fill="url(#accent)" opacity="0.6"/>
  <!-- Decorative chart hint -->
  <polyline points="700,420 760,390 820,400 880,360 940,370 1000,330 1060,340 1120,300" fill="none" stroke="#4fe0b0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  <polyline points="700,440 760,450 820,430 880,460 940,445 1000,470 1060,455 1120,480" fill="none" stroke="#ffc24d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
</svg>`;

async function main() {
  // Favicon 32x32 PNG
  await sharp(Buffer.from(faviconSvg))
    .resize(32, 32)
    .png()
    .toFile(resolve(pub, 'favicon-32.png'));
  console.log('✓ favicon-32.png');

  // Apple Touch Icon 180x180
  await sharp(Buffer.from(touchIconSvg))
    .resize(180, 180)
    .png()
    .toFile(resolve(pub, 'apple-touch-icon.png'));
  console.log('✓ apple-touch-icon.png');

  // OG Image 1200x630
  await sharp(Buffer.from(ogSvg))
    .resize(1200, 630)
    .png()
    .toFile(resolve(pub, 'og.png'));
  console.log('✓ og.png');
}

main().catch(e => { console.error(e); process.exit(1); });
