/**
 * Script to generate a complete codebase dump of the repository into CODEBASE_DUMP.md.
 * Excludes node_modules, build artifacts, git tracking, databases, and binary assets.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const OUTPUT_FILE = path.join(ROOT_DIR, 'CODEBASE_DUMP.md');

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.gemini',
  'data',
  '.system_generated',
  'coverage',
  '.turbo',
  '.next',
]);

const EXCLUDE_FILES = new Set([
  'package-lock.json',
  'CODEBASE_DUMP.md',
  'codebase_dump.md',
  'codebase_dump.txt',
]);

const EXCLUDE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.sqlite',
  '.sqlite-journal',
  '.lock',
  '.log',
  '.map',
  '.webp',
]);

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.css':
      return 'css';
    case '.html':
      return 'html';
    case '.sql':
      return 'sql';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.env':
    case '.example':
      return 'shell';
    default:
      return '';
  }
}

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const item of list) {
    if (EXCLUDE_DIRS.has(item) || EXCLUDE_FILES.has(item)) continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      const ext = path.extname(item).toLowerCase();
      if (!EXCLUDE_EXTS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const files = walk(ROOT_DIR)
  .map((p) => path.relative(ROOT_DIR, p).replace(/\\/g, '/'))
  .sort((a, b) => {
    // Rank root configs first, then packages, apps, tests
    const rank = (f) => {
      if (!f.includes('/')) return 0;
      if (f.startsWith('packages/shared')) return 1;
      if (f.startsWith('packages/protocol')) return 2;
      if (f.startsWith('apps/api')) return 3;
      if (f.startsWith('apps/web')) return 4;
      if (f.startsWith('tests')) return 5;
      return 6;
    };
    const rA = rank(a);
    const rB = rank(b);
    if (rA !== rB) return rA - rB;
    return a.localeCompare(b);
  });

console.log(`Collecting ${files.length} source files...`);

const out = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf8' });

out.write(`# AGENTIC COMMERCE FIREWALL — CODEBASE DUMP\n\n`);
out.write(`> Generated: ${new Date().toISOString()}\n`);
out.write(`> Total Source Files: ${files.length}\n\n`);

out.write(`## Repository File Index\n\n`);
for (const file of files) {
  out.write(`- [${file}](#file-${file.replace(/[^a-zA-Z0-9_-]/g, '-')})\n`);
}
out.write(`\n---\n\n`);

for (const file of files) {
  const fullPath = path.join(ROOT_DIR, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  const lang = getLanguage(file);
  const anchor = `file-${file.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  out.write(`### <a id="${anchor}"></a>File: \`${file}\`\n\n`);
  out.write('```' + lang + '\n');
  out.write(content);
  if (!content.endsWith('\n')) out.write('\n');
  out.write('```\n\n');
  out.write(`[Back to top](#repository-file-index)\n\n---\n\n`);
}

out.end(() => {
  const stat = fs.statSync(OUTPUT_FILE);
  console.log(`CODEBASE_DUMP.md successfully generated: ${(stat.size / 1024).toFixed(1)} KB`);
});
