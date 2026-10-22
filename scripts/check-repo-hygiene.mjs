#!/usr/bin/env node
/**
 * Guard vệ sinh repo (ADR-010) — quét TOÀN BỘ cây git (không chỉ diff):
 * 1) Không file biên dịch bị track: mọi file `.js`/`.d.ts`/`.js.map` bị
 *    track ngoài `dist/` và `node_modules/` đều fail, trừ whitelist tường
 *    minh COMPILED_ALLOWLIST (hiện rỗng — ngoại lệ lịch sử đã gỡ hết).
 * 2) Không thư mục `dist/` bị track ở bất kỳ đâu.
 * 3) Không nhãn phase (`P` + số đứng độc lập) trong nội dung và trong TÊN
 *    FILE thuộc `apps/*\/src`, `apps/*\/test`, `packages/*\/src` — nhãn
 *    phase chỉ sống trong `docs/`.
 *
 * Dùng: node scripts/check-repo-hygiene.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Whitelist tường minh cho guard 1: chỉ thêm file vào đây kèm ADR. */
const COMPILED_ALLOWLIST = new Set([]);

const PHASE_SCOPES = [/^apps\/[^/]+\/(src|test)\//, /^packages\/[^/]+\/src\//];
const PHASE_PATTERN = /\bP\d+\b/;
const PHASE_FILENAME_PATTERN = /(^|[-_])p\d+([-_.]|$)/i;

let failures = 0;

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const file of tracked) {
  if (/(^|\/)dist\//.test(file)) {
    console.error(`[hygiene] tracked dist output: ${file}`);
    failures += 1;
    continue;
  }
  if (
    /\.(js|d\.ts|js\.map)$/.test(file) &&
    !file.includes('node_modules/') &&
    !COMPILED_ALLOWLIST.has(file)
  ) {
    console.error(`[hygiene] compiled artifact tracked: ${file}`);
    failures += 1;
  }
  if (PHASE_SCOPES.some((scope) => scope.test(file))) {
    const base = file.split('/').pop() ?? '';
    if (PHASE_FILENAME_PATTERN.test(base)) {
      console.error(`[hygiene] phase label in file name: ${file}`);
      failures += 1;
    }
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // file bị xoá khỏi cây làm việc nhưng còn trong index: bỏ qua nội dung
    }
    content.split('\n').forEach((line, idx) => {
      if (PHASE_PATTERN.test(line)) {
        console.error(`[hygiene] phase label in ${file}:${idx + 1}: ${line.slice(0, 120)}`);
        failures += 1;
      }
    });
  }
}

if (failures > 0) {
  console.error(`[hygiene] FAILED with ${failures} violation(s)`);
  process.exit(1);
}
console.log('[hygiene] OK — no tracked compiled artifacts, no tracked dist, no phase labels in src/test');
