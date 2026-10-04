import { defineConfig } from '@playwright/test';

/**
 * 运行时冒烟测试配置（第 36 轮）：静态文本护栏挡不住几何/交互/渲染类
 * bug（"100 分压在 90 线上"那次已证明），这里用真实浏览器补上这一层。
 * webServer 负责起 dev server；CI 中不复用既有服务。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
