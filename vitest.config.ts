import { defineConfig } from 'vitest/config';

/**
 * 修复 SP1-01：Vitest 默认会把 harness/regression.spec.js 当成测试套件
 * （该文件是 Playwright 回归脚本工件，报 "No test suite found"），导致真实测试
 * 全部通过但整体 exit 1。此文件显式收窄 include 到 tests/，并显式排除 harness/**。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/harness/**'],
  },
});
