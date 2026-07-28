import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import GithubSlugger from 'github-slugger';

const __dirname = dirname(fileURLToPath(import.meta.url));

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, '.pages');
const SITE_DOCS = join(ROOT, 'site', 'docs');
const PUBLIC = join(ROOT, 'public');
const BASE_URL = 'https://nomadop.github.io/session-watcher';
const BASE_PATH = '/session-watcher';

// Load manifest
const { docs } = await import(join(__dirname, 'docs-manifest.mjs'));

// Setup marked with KaTeX
const marked = new Marked();
marked.use(markedKatex({ throwOnError: false }));

// Custom heading renderer to emit id attributes for anchor linking (uses github-slugger for consistency)
const headingSlugger = new GithubSlugger();
marked.use({
  renderer: {
    heading({ text, depth }) {
      const raw = text.replace(/<[^>]*>/g, '');
      return `<h${depth} id="${headingSlugger.slug(raw)}">${text}</h${depth}>\n`;
    }
  }
});

// Copy KaTeX CSS + fonts to output (done after clean, before page generation)
const KATEX_DIST = join(ROOT, 'node_modules', 'katex', 'dist');

// --- Step 1: Clean output ---
rmSync(OUT, { recursive: true, force: true });

// --- Step 2: Copy public/ → .pages/ ---
cpSync(PUBLIC, OUT, { recursive: true });

// --- Step 2b: Copy KaTeX assets (CSS + fonts) ---
const katexOut = join(OUT, 'assets', 'katex');
mkdirSync(katexOut, { recursive: true });
cpSync(join(KATEX_DIST, 'katex.min.css'), join(katexOut, 'katex.min.css'));
cpSync(join(KATEX_DIST, 'fonts'), join(katexOut, 'fonts'), { recursive: true });

// --- Step 3: Validate manifest ---
for (const page of docs) {
  if (!page.slug || !page.title || !page.description) {
    console.error(`Manifest entry missing required fields: ${JSON.stringify(page)}`);
    process.exit(1);
  }
}

// --- Step 4: Read and validate source docs ---
const sources = new Map();
for (const page of docs) {
  const filePath = join(SITE_DOCS, `${page.slug}.md`);
  if (!existsSync(filePath)) {
    console.error(`Source file missing: ${filePath}`);
    process.exit(1);
  }
  const content = readFileSync(filePath, 'utf8');

  // Validate: exactly one H1 as first heading, must be at start of file
  const contentNoFences = content.replace(/^```[^]*?^```/gm, '');
  const firstHeading = contentNoFences.match(/^(#{1,6})\s/);
  if (!firstHeading || firstHeading[1] !== '#') {
    console.error(`${page.slug}.md: first heading must be a single H1 at start of file`);
    process.exit(1);
  }
  const h1Count = (contentNoFences.match(/^# /gm) || []).length;
  if (h1Count !== 1) {
    console.error(`${page.slug}.md: must have exactly one H1, found ${h1Count}`);
    process.exit(1);
  }

  sources.set(page.slug, content);
}

// --- Step 5: Copy raw markdown → .pages/docs/*.md ---
const docsOut = join(OUT, 'docs');
mkdirSync(docsOut, { recursive: true });
for (const page of docs) {
  writeFileSync(join(docsOut, `${page.slug}.md`), sources.get(page.slug));
}

// --- Step 6: Render HTML for each page ---
const NAV_STYLE = `
body { max-width: 48rem; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; }
nav { border-bottom: 1px solid #e0e0e0; padding-bottom: 0.5rem; margin-bottom: 2rem; }
nav a, nav strong { margin-right: 0.75rem; text-decoration: none; }
nav a { color: #0066cc; }
nav a:hover { text-decoration: underline; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e0e0e0; font-size: 0.875rem; color: #666; }
pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 4px; }
code { font-size: 0.9em; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
th { background: #f9f9f9; }
`.trim();

function buildNav(currentSlug) {
  const items = [
    { href: `${BASE_PATH}/docs/`, label: 'Docs', slug: null },
    ...docs.map(d => ({ href: `${BASE_PATH}/docs/${d.slug}/`, label: d.title, slug: d.slug })),
  ];
  return items.map(item => {
    if (item.slug === currentSlug) {
      return `<strong aria-current="page">${escapeHtml(item.label)}</strong>`;
    }
    return `<a href="${item.href}">${escapeHtml(item.label)}</a>`;
  }).join(' · ');
}

function buildPage(slug, title, description, htmlContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${BASE_URL}/docs/${slug}/">
  <link rel="alternate" type="text/markdown" href="${BASE_URL}/docs/${slug}.md">
  <title>${escapeHtml(title)} — Session Watcher Docs</title>
  <style>${NAV_STYLE}</style>
  <link rel="stylesheet" href="${BASE_PATH}/assets/katex/katex.min.css">
</head>
<body>
  <nav>${buildNav(slug)}</nav>
  <main>${htmlContent}</main>
  <footer>
    <a href="https://github.com/nomadop/session-watcher/blob/main/site/docs/${slug}.md">View source</a>
  </footer>
</body>
</html>`;
}

for (const page of docs) {
  headingSlugger.reset();
  const md = sources.get(page.slug);
  const htmlContent = marked.parse(md);
  const html = buildPage(page.slug, page.title, page.description, htmlContent);
  const pageDir = join(docsOut, page.slug);
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(pageDir, 'index.html'), html);
}

// --- Step 7: Generate docs landing page (structured index) ---
function extractHeadings(md) {
  const headings = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+)/);
    if (m) headings.push({ level: m[1].length, text: m[2].replace(/[*`]/g, '') });
  }
  return headings;
}

const landingItems = docs.map(d => {
  const md = sources.get(d.slug);
  const headings = extractHeadings(md);
  const landingSlugger = new GithubSlugger();
  const sectionLinks = headings
    .filter(h => h.level === 2)
    .map(h => {
      const subsections = headings.filter(s => s.level === 3 && headings.indexOf(s) > headings.indexOf(h) &&
        (headings.findIndex((n, i) => i > headings.indexOf(h) && n.level === 2) === -1 ||
         headings.indexOf(s) < headings.findIndex((n, i) => i > headings.indexOf(h) && n.level === 2)));
      let li = `<li><a href="${BASE_PATH}/docs/${d.slug}/#${landingSlugger.slug(h.text)}">${escapeHtml(h.text)}</a>`;
      if (subsections.length > 0) {
        li += `<ul>${subsections.map(s => `<li><a href="${BASE_PATH}/docs/${d.slug}/#${landingSlugger.slug(s.text)}">${escapeHtml(s.text)}</a></li>`).join('')}</ul>`;
      }
      li += '</li>';
      return li;
    }).join('\n      ');
  return `<h2><a href="${BASE_PATH}/docs/${d.slug}/">${escapeHtml(d.title)}</a></h2>\n    <ul>\n      ${sectionLinks}\n    </ul>`;
}).join('\n    ');

const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Session Watcher documentation index">
  <link rel="canonical" href="${BASE_URL}/docs/">
  <title>Documentation — Session Watcher</title>
  <style>${NAV_STYLE}</style>
</head>
<body>
  <nav>${buildNav(null)}</nav>
  <main>
    <h1>Session Watcher Documentation</h1>
    <p>Session Watcher observes the cost curve of a Claude Code session and helps you decide when to hand off.</p>
    ${landingItems}
  </main>
</body>
</html>`;
writeFileSync(join(docsOut, 'index.html'), landingHtml);

// --- Step 8: Generate llms.txt ---
const preamble = readFileSync(join(SITE_DOCS, 'llms-preamble.md'), 'utf8');
const llmsLinks = docs.map(d =>
  `- [${d.title}](${BASE_URL}/docs/${d.slug}.md): ${d.description}`
).join('\n');
const llmsTxt = `${preamble.trim()}

## Documentation

${llmsLinks}

## Project

- [Repository](https://github.com/nomadop/session-watcher): Source code, issues, releases.
- [npm Package](https://www.npmjs.com/package/@nomadop/session-watcher): Published package.
- [Paper](https://doi.org/10.5281/zenodo.21236704): Cost-model derivation and empirical motivation.

## Optional

- [Complete Documentation](${BASE_URL}/llms-full.txt): All public documentation concatenated into one context file.
`;
writeFileSync(join(OUT, 'llms.txt'), llmsTxt);

// --- Step 9: Generate llms-full.txt ---
function demoteHeadings(content, manifestTitle) {
  // Remove H1 line, replace with H2 from manifest title
  const withoutH1 = content.replace(/^# .+\n*/, '');
  // Demote all remaining headings by one level
  const demoted = withoutH1.replace(/^(#{2,5}) /gm, (_, hashes) => '#' + hashes + ' ');
  return `## ${manifestTitle}\n\n${demoted.trim()}`;
}

const fullSections = docs.map(d => demoteHeadings(sources.get(d.slug), d.title));
const llmsFullTxt = `${preamble.trim()}

---

${fullSections.join('\n\n---\n\n')}
`;
writeFileSync(join(OUT, 'llms-full.txt'), llmsFullTxt);

// --- Step 10: Output validation ---
const errors = [];

// All expected files exist
const expectedFiles = [
  'index.html', 'llms.txt', 'llms-full.txt',
  'docs/index.html',
  'assets/katex/katex.min.css',
  ...docs.flatMap(d => [`docs/${d.slug}.md`, `docs/${d.slug}/index.html`]),
];
for (const f of expectedFiles) {
  if (!existsSync(join(OUT, f))) errors.push(`Missing: .pages/${f}`);
}
// KaTeX fonts directory must exist
if (!existsSync(join(OUT, 'assets', 'katex', 'fonts'))) {
  errors.push('Missing: .pages/assets/katex/fonts/');
}

// llms.txt contains expected link count
const llmsContent = readFileSync(join(OUT, 'llms.txt'), 'utf8');
const linkCount = (llmsContent.match(/^\- \[/gm) || []).length;
const expectedLinks = docs.length + 4; // docs + 3 project + 1 optional
if (linkCount !== expectedLinks) errors.push(`llms.txt: expected ${expectedLinks} links, found ${linkCount}`);

// llms-full.txt contains expected section headings (one ## per manifest page)
const fullContent = readFileSync(join(OUT, 'llms-full.txt'), 'utf8');
const sectionHeadings = docs.filter(d => new RegExp(`^## ${d.title}$`, 'm').test(fullContent));
if (sectionHeadings.length !== docs.length) errors.push(`llms-full.txt: expected ${docs.length} section headings, found ${sectionHeadings.length}`);

if (errors.length) {
  console.error('Output validation failed:');
  errors.forEach(e => console.error(`  ${e}`));
  process.exit(1);
}

console.log(`docs build complete: ${expectedFiles.length} files in .pages/`);
