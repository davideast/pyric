import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({ ...base, testMatch: 'section-six-*.packed.ts', timeout: 60_000 });
