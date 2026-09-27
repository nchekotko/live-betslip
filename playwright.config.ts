import { defineConfig, devices } from '@playwright/test';

/**
 * Optional browser e2e (not part of `npm test` / CI): needs a Playwright
 * Chromium build. Run with `npm run e2e`.
 */
const SERVER_PORT = 8790;
const WEB_PORT = 5180;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: 'npx tsx apps/odds-server/src/main.ts',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      env: { PORT: String(SERVER_PORT), CHAOS_DUPLICATE: '0.05', CHAOS_REORDER: '0.05', BET_DELAY_MS: '300' },
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -w @live-betslip/web -- --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { ODDS_SERVER: `http://127.0.0.1:${SERVER_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
