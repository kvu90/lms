#!/usr/bin/env node
/**
 * Guard vệ sinh repo (ADR-010):
 * 1) Không commit sản phẩm biên dịch (.js/.d.ts/.js.map bị track ngoài
 *    dist/ và node_modules), trừ allowlist lịch sử đã ghi trong ADR-010.
 * 2) Không nhãn phase trong các dòng code/comment/test ĐƯỢC THÊM so với
 *    base ref (mặc định HEAD) — nhãn phase chỉ sống trong tài liệu kế hoạch.
 *
 * Dùng: node scripts/check-repo-hygiene.mjs [baseRef]
 */
import { execSync } from 'node:child_process';

const base = process.argv[2] ?? 'HEAD';
const LEGACY_COMPILED = new Set([
  'apps/api/drizzle.config.js',
  'apps/api/drizzle.config.d.ts',
  'apps/api/drizzle.config.js.map',
]);

let failures = 0;

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const file of tracked) {
  if (/\.(js|d\.ts|js\.map)$/.test(file) && !file.includes('/dist/') && !file.includes('node_modules/') && !LEGACY_COMPILED.has(file)) {
    console.error(`[hygiene] compiled artifact tracked: ${file}`);
    failures += 1;
  }
}

const diff = execSync(`git diff --unified=0 ${base} -- apps/*/src apps/*/test packages/*/src`, { encoding: 'utf8' });
for (const line of diff.split('\n')) {
  if (line.startsWith('+') && !line.startsWith('+++') && /\bP\d+\b/.test(line)) {
    console.error(`[hygiene] phase label in added line: ${line.slice(0, 120)}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`[hygiene] FAILED with ${failures} violation(s)`);
  process.exit(1);
}
console.log('[hygiene] OK — no tracked compiled artifacts, no phase labels in added lines');
