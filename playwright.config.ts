import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4100', channel: process.env.PW_CHANNEL, trace: 'retain-on-failure' },
  webServer: { command: 'PORT=4100 node dist/server/main.js', url: 'http://127.0.0.1:4100', reuseExistingServer: !process.env.CI },
});
