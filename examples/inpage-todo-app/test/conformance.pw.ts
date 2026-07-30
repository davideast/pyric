import { test, expect } from '@playwright/test';

const PROTOTYPE_FILE_URL = 'file:///usr/local/google/home/deast/.gemini/jetski/brain/43018345-0471-48ef-b32b-05c68d988433/shadcn_todo_app.html';

test.describe('Prototype and React Visual & Structural Conformance', () => {
  test('original prototype static HTML structure and visual classes conformance', async ({ page }) => {
    await page.goto(PROTOTYPE_FILE_URL);

    // Verify Header and Title Structure
    const h1 = page.locator('h1');
    await expect(h1).toHaveText('Tasks');

    const subtitle = page.locator('p').filter({ hasText: 'Manage your daily goals, image attachments, and onboarding milestones.' });
    await expect(subtitle).toBeVisible();

    // Verify Stat Badge Counters
    await expect(page.locator('#stat-total')).toHaveText('4 Total');
    await expect(page.locator('#stat-active')).toHaveText('3 Active');
    await expect(page.locator('#stat-completed')).toHaveText('1 Done');

    // Verify Form and Toolbar Input Placeholders
    await expect(page.locator('#new-task-input')).toHaveAttribute('placeholder', 'What needs to be done?');
    await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Search tasks...');

    // Verify Filter Tabs
    await expect(page.locator('#tab-all')).toHaveText('All');
    await expect(page.locator('#tab-active')).toHaveText('Active');
    await expect(page.locator('#tab-completed')).toHaveText('Completed');

    // Verify Initial Task List Contents under #todo-list
    const todoList = page.locator('#todo-list');
    await expect(todoList).toBeVisible();

    const tasks = todoList.locator('.group');
    await expect(tasks).toHaveCount(4);

    // Verify specific seeded task text is present
    await expect(page.locator('#todo-list')).toContainText('Implement passkey authentication flow in auth provider');
    await expect(page.locator('#todo-list')).toContainText('Review shadcn monochromatic color contrast for WCAG AA');
    await expect(page.locator('#todo-list')).toContainText('Refactor Tailwind utility classes and CSS theme variables');
    await expect(page.locator('#todo-list')).toContainText('Write integration unit tests for database mutations');
  });

  test('react version structural and visual parity with prototype', async ({ page }) => {
    await page.goto('http://127.0.0.1:5174');

    // Wait for tasks to be loaded and rendered from local in-page sandbox
    const todoList = page.locator('#todo-list');
    await expect(todoList).toBeVisible({ timeout: 15_000 });

    // Verify Header and Title Structure match Prototype
    const h1 = page.locator('h1');
    await expect(h1).toHaveText('Tasks');

    const subtitle = page.locator('p').filter({ hasText: 'Manage your daily goals, image attachments, and onboarding milestones.' });
    await expect(subtitle).toBeVisible();

    // Verify Stat Badge Counters match Prototype exactly
    await expect(page.locator('#stat-total')).toHaveText('4 Total');
    await expect(page.locator('#stat-active')).toHaveText('3 Active');
    await expect(page.locator('#stat-completed')).toHaveText('1 Done');

    // Verify Form and Toolbar Input Placeholders match Prototype
    await expect(page.locator('#new-task-input')).toHaveAttribute('placeholder', 'What needs to be done?');
    await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Search tasks...');

    // Verify Filter Tabs match Prototype
    await expect(page.locator('#tab-all')).toHaveText('All');
    await expect(page.locator('#tab-active')).toHaveText('Active');
    await expect(page.locator('#tab-completed')).toHaveText('Completed');

    // Verify Initial Task List Contents match Prototype
    const tasks = todoList.locator('.group');
    await expect(tasks).toHaveCount(4);

    // Verify specific seeded task text is present
    await expect(page.locator('#todo-list')).toContainText('Implement passkey authentication flow in auth provider');
    await expect(page.locator('#todo-list')).toContainText('Review shadcn monochromatic color contrast for WCAG AA');
    await expect(page.locator('#todo-list')).toContainText('Refactor Tailwind utility classes and CSS theme variables');
    await expect(page.locator('#todo-list')).toContainText('Write integration unit tests for database mutations');

    // Verify CSS Theme Variable configuration matches prototype palette
    const bgVal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-background').trim());
    const cardVal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-card').trim());
    const borderVal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-border').trim());

    expect(bgVal.toLowerCase()).toBe('#ffffff');
    expect(cardVal.toLowerCase()).toBe('#ffffff');
    expect(borderVal.toLowerCase()).toBe('#e4e4e7');
  });
});
