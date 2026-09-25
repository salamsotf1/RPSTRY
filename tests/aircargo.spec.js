const { test, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const reportDirectory = path.join(__dirname, '..', 'reports');
const reportPath = path.join(reportDirectory, 'aircargo-test-results.xlsx');
let bookingResult = {};

function writeExcelResult(testInfo) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  const rows = [{
    test: testInfo.title,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    route: bookingResult.route || '',
    bookingReference: bookingResult.bookingReference || '',
    estimate: bookingResult.estimate || '',
    shipmentCount: bookingResult.shipmentCount || '',
    completedAt: new Date().toISOString(),
    error: testInfo.errors.map((error) => error.message).join(' | ')
  }];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Test Results');
  XLSX.writeFile(workbook, reportPath);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html#booking');
  await page.evaluate(() => localStorage.clear());
});

test.afterEach(async ({}, testInfo) => {
  writeExcelResult(testInfo);
});

test('creates an air cargo booking and exports the result', async ({ page }) => {
  bookingResult = {};
  await page.goto('/index.html#booking');
  await page.locator('#origin').fill('Amsterdam');
  await page.locator('#destination').fill('Singapore');
  await page.locator('[aria-label="Pieces"]').fill('18');
  await page.locator('[aria-label="Total weight"]').fill('1200');
  await page.locator('[aria-label="Volume"]').fill('6.5');
  await page.locator('[aria-label="Cargo description"]').fill('Lithium-free consumer electronics');
  await page.locator('.mode-tab[data-mode="multi-leg"]').click();
  await page.locator('label.check-option').nth(2).click();
  await page.locator('#continue-btn').click();

  bookingResult = {
    route: (await page.locator('#confirmation-route').textContent()).trim(),
    bookingReference: (await page.locator('#booking-reference').textContent()).trim(),
    estimate: (await page.locator('#confirmation-total').textContent()).trim(),
    shipmentCount: (await page.locator('#shipment-count').textContent()).trim()
  };

  await expect(page.locator('#booking-modal')).toHaveClass(/open/);
  await expect(page.locator('#confirmation-route')).toHaveText('Amsterdam → Singapore');
  await expect(page.locator('#confirmation-total')).toHaveText('$5,484.00');
});

test('saves booking form data locally between visits', async ({ page }) => {
  await page.goto('/index.html#booking');
  await page.locator('#origin').fill('Frankfurt');
  await page.locator('#destination').fill('Tokyo');
  await page.locator('[aria-label="Pieces"]').fill('9');
  await page.locator('[aria-label="Total weight"]').fill('600');
  await page.locator('[aria-label="Volume"]').fill('3.4');
  await page.locator('[aria-label="Cargo description"]').fill('Medical devices');
  await page.locator('.mode-tab[data-mode="round-trip"]').click();

  await page.reload();

  await expect(page.locator('#origin')).toHaveValue('Frankfurt');
  await expect(page.locator('#destination')).toHaveValue('Tokyo');
  await expect(page.locator('[aria-label="Pieces"]')).toHaveValue('9');
  await expect(page.locator('[aria-label="Cargo description"]')).toHaveValue('Medical devices');
  await expect(page.locator('.mode-tab.selected')).toHaveText('Round trip');
});

test('shows saved bookings and lets users search them', async ({ page }) => {
  await page.goto('/index.html#booking');
  await page.locator('#origin').fill('Chicago');
  await page.locator('#destination').fill('Dubai');
  await page.locator('[aria-label="Pieces"]').fill('7');
  await page.locator('[aria-label="Total weight"]').fill('520');
  await page.locator('[aria-label="Volume"]').fill('2.9');
  await page.locator('[aria-label="Cargo description"]').fill('Industrial components');
  await page.locator('#continue-btn').click();

  await page.goto('/index.html#billing');
  await expect(page.locator('.saved-booking-item')).toHaveCount(1);
  await expect(page.locator('.saved-booking-item')).toContainText('Chicago → Dubai');

  await page.locator('#booking-search').fill('industrial');
  await expect(page.locator('.saved-booking-item')).toHaveCount(1);
  await expect(page.locator('.saved-booking-item')).toContainText('Industrial components');

  await page.locator('#booking-search').fill('not-found');
  await expect(page.locator('.empty-bookings')).toContainText('No saved bookings match your search.');
});

test('allows deleting saved bookings and clearing all stored bookings', async ({ page }) => {
  await page.goto('/index.html#booking');

  for (const [origin, destination, cargo] of [
    ['Paris', 'New York', 'Pharma samples'],
    ['Berlin', 'Tokyo', 'Testing equipment']
  ]) {
    await page.locator('#origin').fill(origin);
    await page.locator('#destination').fill(destination);
    await page.locator('[aria-label="Pieces"]').fill('3');
    await page.locator('[aria-label="Total weight"]').fill('240');
    await page.locator('[aria-label="Volume"]').fill('1.4');
    await page.locator('[aria-label="Cargo description"]').fill(cargo);
    await page.locator('#continue-btn').click();
    await page.locator('#new-booking').click();
  }

  await page.goto('/index.html#billing');
  await expect(page.locator('.saved-booking-item')).toHaveCount(2);
  await page.locator('.saved-booking-item .delete-booking').first().click();
  await expect(page.locator('.saved-booking-item')).toHaveCount(1);

  await page.locator('#clear-all-bookings').click();
  await expect(page.locator('.empty-bookings')).toContainText('No saved bookings yet.');
});

test('loads booking and Master AWB details by AWB number search', async ({ page }) => {
  await page.goto('/index.html#booking');
  await page.locator('#booking-awb-search').fill('AWB-778899');
  await page.locator('#origin').fill('Lisbon');
  await page.locator('#destination').fill('Doha');
  await page.locator('[aria-label="Pieces"]').fill('5');
  await page.locator('[aria-label="Total weight"]').fill('330');
  await page.locator('[aria-label="Volume"]').fill('2.1');
  await page.locator('[aria-label="Cargo description"]').fill('Fresh produce');
  await page.locator('#continue-btn').click();

  await page.goto('/index.html#awb');
  await page.locator('.topbar:visible .global-awb-search').fill('AWB-778899');
  await page.locator('.topbar:visible .global-awb-go').click();
  await expect(page.locator('#awb-number')).toHaveValue('AWB-778899');
  await expect(page.locator('#awb-origin')).toHaveValue('AMS · Amsterdam');

  await page.goto('/index.html#booking');
  await page.locator('.topbar:visible .global-awb-search').fill('AWB-778899');
  await page.locator('.topbar:visible .global-awb-go').click();
  await expect(page.locator('#origin')).toHaveValue('Lisbon');
  await expect(page.locator('#destination')).toHaveValue('Doha');
  await expect(page.locator('[aria-label="Cargo description"]')).toHaveValue('Fresh produce');
});

test.afterAll(() => {
  console.log(`Excel report written to ${reportPath}`);
});