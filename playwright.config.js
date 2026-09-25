const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8000',
    screenshot: 'on',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'python3 -m http.server 8000',
    url: 'http://127.0.0.1:8000/index.html',
    reuseExistingServer: true,
    timeout: 10_000
  }
});