const origin = document.querySelector('#origin');
const destination = document.querySelector('#destination');
const swapButton = document.querySelector('#swap-route');
const toast = document.querySelector('#toast');
const totalPrice = document.querySelector('#total-price');
const basePrice = document.querySelector('#base-price');
const airportCodes = { Amsterdam: 'AMS', Singapore: 'SIN' };
const modal = document.querySelector('#booking-modal');
const shipmentCount = document.querySelector('#shipment-count');

const formDraftKey = 'liftline-form-draft';
const awbStoreKey = 'liftline-awb-records';
const searchBookingsPageSize = 25;
let searchBookingsCurrentPage = 1;
const formDraftSelectors = [
  '#booking-awb-search', '.global-awb-search', '#origin', '#destination', '#departure', '[aria-label="Ready time"]', '[aria-label="Pieces"]',
  '[aria-label="Total weight"]', '[aria-label="Volume"]', '[aria-label="Cargo description"]',
  '#awb-search', '#awb-number', '#awb-carrier', '#awb-date', '#awb-flight', '#awb-shipper', '#awb-consignee',
  '#awb-origin', '#awb-destination'
];

function normalizeAwb(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeRecordAwb(value) {
  return normalizeAwb(value || '').replace(/^AWB(?=-)/, 'AWB');
}

function getLegacyBookings() {
  const stored = localStorage.getItem('liftline-bookings');
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch (error) {
    console.warn('Unable to parse legacy bookings', error);
    return [];
  }
}

function getLegacyMasterAwbs() {
  const stored = localStorage.getItem('liftline-master-awbs');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (error) {
      console.warn('Unable to parse legacy master AWBs', error);
    }
  }

  const legacy = localStorage.getItem('liftline-master-awb');
  if (!legacy) return [];
  try {
    return [JSON.parse(legacy)];
  } catch (error) {
    console.warn('Unable to parse legacy master AWB', error);
    return [];
  }
}

function getAwbRecords() {
  const stored = localStorage.getItem(awbStoreKey);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (error) {
      console.warn('Unable to parse AWB records', error);
    }
  }

  const merged = {};
  getLegacyBookings().forEach((booking) => {
    const key = normalizeRecordAwb(booking.awbNumber || booking.reference);
    if (!key) return;
    merged[key] = { ...merged[key], booking: { ...booking, awbNumber: key } };
  });
  getLegacyMasterAwbs().forEach((awb) => {
    const key = normalizeRecordAwb(awb.number);
    if (!key) return;
    merged[key] = { ...merged[key], masterAwb: { ...awb, number: key } };
  });

  localStorage.setItem(awbStoreKey, JSON.stringify(merged));
  return merged;
}

function rebuildAwbStore(bookings, masterAwbs) {
  const store = {};

  bookings.forEach((booking) => {
    const key = normalizeRecordAwb(booking.awbNumber || booking.reference);
    if (!key) return;
    store[key] = { ...(store[key] || {}), booking: { ...booking, awbNumber: key } };
  });

  masterAwbs.forEach((awb) => {
    const key = normalizeRecordAwb(awb.number);
    if (!key) return;
    store[key] = { ...(store[key] || {}), masterAwb: { ...awb, number: key } };
  });

  localStorage.setItem(awbStoreKey, JSON.stringify(store));
  localStorage.setItem('liftline-bookings', JSON.stringify(bookings));
  localStorage.setItem('liftline-master-awbs', JSON.stringify(masterAwbs));
}

function syncLegacyAwbLists(store) {
  const bookings = Object.values(store)
    .map((entry) => (entry && entry.booking ? { ...entry.booking, awbNumber: normalizeRecordAwb(entry.booking.awbNumber || entry.booking.reference) } : null))
    .filter(Boolean);
  const masterAwbs = Object.values(store)
    .map((entry) => (entry && entry.masterAwb ? { ...entry.masterAwb, number: normalizeRecordAwb(entry.masterAwb.number) } : null))
    .filter(Boolean);

  localStorage.setItem('liftline-bookings', JSON.stringify(bookings));
  localStorage.setItem('liftline-master-awbs', JSON.stringify(masterAwbs));
}

function saveAwbRecord(awbNumber, partial) {
  const normalized = normalizeRecordAwb(awbNumber);
  if (!normalized) return;

  const store = getAwbRecords();
  const existing = store[normalized] || {};

  store[normalized] = {
    ...existing,
    ...partial,
    booking: { ...(existing.booking || {}), ...(partial.booking || {}), awbNumber: normalized },
    masterAwb: { ...(existing.masterAwb || {}), ...(partial.masterAwb || {}), number: normalized }
  };

  localStorage.setItem(awbStoreKey, JSON.stringify(store));
  syncLegacyAwbLists(store);
}

function getBookings() {
  const store = getAwbRecords();
  if (Object.keys(store).length) {
    return Object.values(store)
      .map((entry) => (entry && entry.booking ? { ...entry.booking, awbNumber: normalizeRecordAwb(entry.booking.awbNumber || entry.booking.reference) } : null))
      .filter(Boolean);
  }
  return getLegacyBookings();
}

function getMasterAwbs() {
  const stored = localStorage.getItem('liftline-master-awbs');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (error) {
      console.warn('Unable to parse Master AWBs', error);
    }
  }

  const legacy = localStorage.getItem('liftline-master-awb');
  return legacy ? [JSON.parse(legacy)] : [];
}

function saveFormDraft() {
  const draft = {
    selectedMode: document.querySelector('.mode-tab.selected')?.dataset.mode || 'one-way',
    fields: {}
  };

  formDraftSelectors.forEach((selector) => {
    const field = document.querySelector(selector);
    if (!field) return;
    draft.fields[selector] = field.value;
  });

  localStorage.setItem(formDraftKey, JSON.stringify(draft));
}

function restoreFormDraft() {
  const savedDraft = JSON.parse(localStorage.getItem(formDraftKey) || '{}');
  const savedFields = savedDraft.fields || {};

  formDraftSelectors.forEach((selector) => {
    const field = document.querySelector(selector);
    if (!field || savedFields[selector] === undefined) return;
    field.value = savedFields[selector];
  });

  const selectedMode = savedDraft.selectedMode || 'one-way';
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const isSelected = tab.dataset.mode === selectedMode;
    tab.classList.toggle('selected', isSelected);
  });

  updateRouteSummary();
}

function renderStoredBookings() {
  const bookings = getBookings();
  const list = document.querySelector('#saved-bookings-list');
  const searchInput = document.querySelector('#booking-search');
  const searchValue = (searchInput?.value || '').trim().toLowerCase();

  if (!list) return;

  if (!bookings.length) {
    list.innerHTML = '<div class="empty-bookings">No saved bookings yet.</div>';
    return;
  }

  const filteredBookings = bookings.filter((booking) => {
    if (!searchValue) return true;
    const searchable = [booking.awbNumber, booking.reference, booking.route, booking.cargo, booking.description, booking.estimate]
      .join(' ')
      .toLowerCase();
    return searchable.includes(searchValue);
  });

  if (!filteredBookings.length) {
    list.innerHTML = '<div class="empty-bookings">No saved bookings match your search.</div>';
    return;
  }

  list.innerHTML = filteredBookings.map((booking, index) => `
    <div class="saved-booking-item" data-reference="${booking.awbNumber || booking.reference}">
      <div class="booking-topline">
        <strong>${booking.awbNumber || booking.reference}</strong>
        <span>${booking.estimate}</span>
      </div>
      <p>${booking.route}</p>
      <div class="booking-meta">
        <span>${booking.description}</span>
        <span>${new Date(booking.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      </div>
      <button class="delete-booking" type="button" data-index="${index}" aria-label="Delete booking ${booking.awbNumber || booking.reference}">Delete</button>
    </div>
  `).join('');

  list.querySelectorAll('.delete-booking').forEach((button) => {
    button.addEventListener('click', () => {
      const allBookings = getBookings();
      const bookingIndex = Number(button.dataset.index);
      const remainingBookings = allBookings.filter((_, idx) => idx !== bookingIndex);
      const masterAwbs = getMasterAwbs();
      const awbToRemove = normalizeRecordAwb(allBookings[bookingIndex]?.awbNumber || allBookings[bookingIndex]?.reference || '');
      const updatedMasterAwbs = awbToRemove ? masterAwbs.filter((awb) => normalizeRecordAwb(awb.number) !== awbToRemove) : masterAwbs;
      rebuildAwbStore(remainingBookings, updatedMasterAwbs);
      renderSearchBookingsPage();
      updateShipmentCount();
      showToast('Booking deleted');
    });
  });
}

function renderSearchBookingsPage() {
  const tableBody = document.querySelector('#search-bookings-body');
  const pagination = document.querySelector('#search-bookings-pagination');
  if (!tableBody || !pagination) return;

  const bookings = getBookings().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const totalPages = Math.max(1, Math.ceil(bookings.length / searchBookingsPageSize));
  if (searchBookingsCurrentPage > totalPages) searchBookingsCurrentPage = totalPages;

  const start = (searchBookingsCurrentPage - 1) * searchBookingsPageSize;
  const pageBookings = bookings.slice(start, start + searchBookingsPageSize);

  if (!bookings.length) {
    tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">No AWBs booked yet.</td></tr>';
    pagination.innerHTML = '';
    return;
  }

  tableBody.innerHTML = pageBookings.map((booking) => `
    <tr>
      <td>${booking.awbNumber || booking.reference || '—'}</td>
      <td>${booking.origin || '—'}</td>
      <td>${booking.destination || '—'}</td>
      <td>${booking.pieces || 0}</td>
      <td>${booking.weight || 0} kg</td>
      <td>${booking.volume || 0} m³</td>
    </tr>
  `).join('');

  pagination.innerHTML = `
    <button type="button" class="page-btn" data-page="prev" ${searchBookingsCurrentPage === 1 ? 'disabled' : ''}>Prev</button>
    <span class="page-indicator">Page ${searchBookingsCurrentPage} of ${totalPages}</span>
    <button type="button" class="page-btn" data-page="next" ${searchBookingsCurrentPage === totalPages ? 'disabled' : ''}>Next</button>
  `;

  pagination.querySelectorAll('.page-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const direction = button.dataset.page;
      if (direction === 'prev' && searchBookingsCurrentPage > 1) {
        searchBookingsCurrentPage -= 1;
      }
      if (direction === 'next' && searchBookingsCurrentPage < totalPages) {
        searchBookingsCurrentPage += 1;
      }
      renderSearchBookingsPage();
    });
  });
}

function getStorageKeyFromAwb(awbNumber) {
  return normalizeAwb(awbNumber || '');
}

function findAwbRecord(awbNumber) {
  const normalized = normalizeRecordAwb(awbNumber);
  if (!normalized) return null;
  return getAwbRecords()[normalized] || null;
}

function findBookingByAwb(awbNumber) {
  const record = findAwbRecord(awbNumber);
  return record?.booking || null;
}

function findMasterAwbByNumber(awbNumber) {
  const record = findAwbRecord(awbNumber);
  return record?.masterAwb || null;
}

function loadBookingDetailsByAwb(awbNumber) {
  const normalized = getStorageKeyFromAwb(awbNumber);
  if (!normalized) return;

  const booking = findBookingByAwb(normalized);
  if (!booking) {
    showToast('No booking found for this AWB');
    return;
  }

  const bookingAwbField = document.querySelector('#booking-awb-search');
  if (bookingAwbField) bookingAwbField.value = booking.awbNumber || normalized;
  syncGlobalAwbSearch(booking.awbNumber || normalized);
  document.querySelector('#origin').value = booking.origin || booking.route.split(' → ')[0] || 'Amsterdam';
  document.querySelector('#destination').value = booking.destination || booking.route.split(' → ')[1] || 'Singapore';
  document.querySelector('[aria-label="Pieces"]').value = booking.pieces || 1;
  document.querySelector('[aria-label="Total weight"]').value = booking.weight || 840;
  document.querySelector('[aria-label="Volume"]').value = booking.volume || 4.8;
  document.querySelector('[aria-label="Cargo description"]').value = booking.description || 'General cargo';
  const selectedMode = booking.mode || 'one-way';
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.classList.toggle('selected', tab.dataset.mode === selectedMode);
  });
  updateRouteSummary();
  saveFormDraft();
  showToast(`Loaded booking ${booking.awbNumber || normalized}`);
}

function loadMasterAwbDetailsByNumber(awbNumber) {
  const normalized = getStorageKeyFromAwb(awbNumber);
  if (!normalized) return;

  const awb = findMasterAwbByNumber(normalized);
  if (!awb) {
    showToast('No Master AWB found for this number');
    return;
  }

  const awbSearch = document.querySelector('#awb-search');
  if (awbSearch) awbSearch.value = awb.number || normalized;
  syncGlobalAwbSearch(awb.number || normalized);
  document.querySelector('#awb-number').value = awb.number || normalized;
  document.querySelector('#awb-carrier').value = awb.carrier || '';
  document.querySelector('#awb-date').value = awb.date || '';
  document.querySelector('#awb-flight').value = awb.flight || '';
  document.querySelector('#awb-shipper').value = awb.shipper || '';
  document.querySelector('#awb-consignee').value = awb.consignee || '';
  document.querySelector('#awb-origin').value = awb.origin || 'AMS · Amsterdam';
  document.querySelector('#awb-destination').value = awb.destination || 'SIN · Singapore';
  saveFormDraft();
  showToast(`Loaded AWB ${awb.number || normalized}`);
}

function executeAwbSearch(rawValue) {
  const awbValue = (rawValue || '').trim();
  if (!awbValue) {
    showToast('Enter an AWB number');
    return;
  }

  const record = findAwbRecord(awbValue);
  if (!record) {
    showToast('No matching AWB found');
    return;
  }

  const hash = window.location.hash.replace('#', '');
  const currentPage = hash === 'awb' ? 'awb' : hash === 'billing' ? 'billing' : 'booking';

  if (currentPage === 'awb' && record.masterAwb) {
    loadMasterAwbDetailsByNumber(awbValue);
    return;
  }

  if (record.booking) {
    loadBookingDetailsByAwb(awbValue);
  }
  if (record.masterAwb && currentPage === 'awb') {
    loadMasterAwbDetailsByNumber(awbValue);
  }
}

function getActiveGlobalSearchField() {
  return document.querySelector('.workspace-page.active .global-awb-search') || document.querySelector('.global-awb-search');
}

function syncGlobalAwbSearch(value) {
  document.querySelectorAll('.global-awb-search').forEach((field) => {
    field.value = value;
  });
}

function updateShipmentCount() {
  shipmentCount.textContent = 12 + getBookings().length;
  renderStoredBookings();
  renderSearchBookingsPage();
}

function updateRouteSummary() {
  document.querySelector('#origin-code').textContent = airportCodes[origin.value] || '---';
  document.querySelector('#destination-code').textContent = airportCodes[destination.value] || '---';
  document.querySelector('#origin-city').textContent = origin.value;
  document.querySelector('#destination-city').textContent = destination.value;
  document.querySelector('#origin-meta').textContent = `${airportCodes[origin.value] || '---'} · ${origin.value}`;
  document.querySelector('#destination-meta').textContent = `${airportCodes[destination.value] || '---'} · ${destination.value}`;
  document.querySelector('#quote-route-name').textContent = `${origin.value} → ${destination.value}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

swapButton.addEventListener('click', () => {
  [origin.value, destination.value] = [destination.value, origin.value];
  updateRouteSummary();
  showToast('Route swapped');
});

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.mode-tab.selected').classList.remove('selected');
    tab.classList.add('selected');
    saveFormDraft();
    showToast(`${tab.textContent} selected`);
  });
});

['input', 'change'].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    if (event.target && event.target.matches(formDraftSelectors.join(','))) {
      saveFormDraft();
    }
  });
});

document.querySelector('#add-cargo').addEventListener('click', () => showToast('Cargo type added'));
document.querySelector('#booking-awb-search')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    executeAwbSearch(event.target.value);
  }
});
document.querySelector('#booking-awb-go')?.addEventListener('click', () => {
  executeAwbSearch(document.querySelector('#booking-awb-search')?.value || '');
});
document.querySelector('#awb-search')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    executeAwbSearch(event.target.value);
  }
});
document.querySelector('#awb-go')?.addEventListener('click', () => {
  executeAwbSearch(document.querySelector('#awb-search')?.value || '');
});
document.querySelectorAll('.global-awb-go').forEach((button) => {
  button.addEventListener('click', () => {
    const value = getActiveGlobalSearchField()?.value || '';
    executeAwbSearch(value);
  });
});
document.querySelectorAll('.global-awb-search').forEach((field) => {
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      executeAwbSearch(event.target.value);
    }
  });
});

document.querySelector('#continue-btn').addEventListener('click', () => {
  if (!origin.value.trim() || !destination.value.trim()) {
    showToast('Add an origin and destination');
    return;
  }
  const weight = Number(document.querySelector('[aria-label="Total weight"]').value) || 0;
  const pieces = Number(document.querySelector('[aria-label="Pieces"]').value) || 0;
  const volume = Number(document.querySelector('[aria-label="Volume"]').value) || 0;
  if (weight <= 0 || pieces <= 0 || volume <= 0) {
    showToast('Complete the cargo details');
    return;
  }
  const estimate = Math.max(840, weight) * 4.57;
  const formatted = estimate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  totalPrice.innerHTML = `$${formatted.slice(0, -3)}<span>${formatted.slice(-3)}</span>`;
  basePrice.textContent = `$${(estimate - 480).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const description = document.querySelector('[aria-label="Cargo description"]').value.trim();
  const requestedAwb = normalizeAwb(document.querySelector('#booking-awb-search')?.value || '');
  const awbNumber = requestedAwb || `AWB-${Date.now().toString().slice(-6)}`;
  const booking = {
    awbNumber,
    reference: `LL-${Date.now().toString().slice(-6)}`,
    route: `${origin.value.trim()} → ${destination.value.trim()}`,
    cargo: `${pieces} pieces · ${weight} kg`,
    description: description || 'General cargo',
    origin: origin.value.trim(),
    destination: destination.value.trim(),
    pieces,
    weight,
    volume,
    estimate: `$${formatted}`,
    mode: document.querySelector('.mode-tab.selected')?.dataset.mode || 'one-way',
    createdAt: new Date().toISOString()
  };
  const masterAwb = {
    number: awbNumber,
    carrier: document.querySelector('#awb-carrier')?.value?.trim() || 'KLM Cargo',
    shipper: document.querySelector('#awb-shipper')?.value?.trim() || '',
    consignee: document.querySelector('#awb-consignee')?.value?.trim() || '',
    origin: document.querySelector('#awb-origin')?.value?.trim() || `${airportCodes[origin.value] || 'AMS'} · ${origin.value}`,
    destination: document.querySelector('#awb-destination')?.value?.trim() || `${airportCodes[destination.value] || 'SIN'} · ${destination.value}`,
    date: document.querySelector('#awb-date')?.value || new Date().toISOString().slice(0, 10),
    flight: document.querySelector('#awb-flight')?.value?.trim() || '',
    savedAt: new Date().toISOString()
  };

  saveAwbRecord(awbNumber, {
    booking: { ...booking, awbNumber },
    masterAwb
  });

  const bookingAwbSearch = document.querySelector('#booking-awb-search');
  if (bookingAwbSearch) bookingAwbSearch.value = awbNumber;
  syncGlobalAwbSearch(awbNumber);
  document.querySelector('#booking-reference').textContent = booking.reference;
  document.querySelector('#confirmation-route').textContent = booking.route;
  document.querySelector('#confirmation-cargo').textContent = booking.cargo;
  document.querySelector('#confirmation-total').textContent = booking.estimate;
  updateShipmentCount();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
});

function closeModal() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

document.querySelector('#modal-close').addEventListener('click', closeModal);
document.querySelector('#new-booking').addEventListener('click', () => {
  closeModal();
  const bookingAwbSearch = document.querySelector('#booking-awb-search');
  if (bookingAwbSearch) bookingAwbSearch.value = '';
  document.querySelector('#origin').focus();
  showToast('Ready for a new booking');
});
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});
updateShipmentCount();
restoreFormDraft();

const bookingView = document.querySelector('main#booking');
const workspacePages = document.querySelectorAll('.workspace-page');
const navItems = document.querySelectorAll('.nav-item');

function showView() {
  closeModal();
  const hash = window.location.hash.replace('#', '');
  const pageName = hash === 'awb' || hash === 'billing' || hash === 'search-bookings' ? hash : 'booking';
  bookingView.style.display = pageName === 'booking' ? '' : 'none';
  workspacePages.forEach((page) => page.classList.toggle('active', page.id === `${pageName}-page`));
  navItems.forEach((item) => item.classList.toggle('active', item.getAttribute('href') === `#${pageName}`));
  renderSearchBookingsPage();
}

window.addEventListener('hashchange', showView);
showView();

document.querySelector('#awb-upload').addEventListener('click', () => showToast('Document picker ready'));
document.querySelector('#awb-save').addEventListener('click', () => showToast('AWB draft saved'));
document.querySelector('#awb-search')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    executeAwbSearch(event.target.value);
  }
});
document.querySelector('#awb-go')?.addEventListener('click', () => {
  executeAwbSearch(document.querySelector('#awb-search')?.value || '');
});
document.querySelector('#awb-submit').addEventListener('click', () => {
  const required = ['#awb-number', '#awb-carrier', '#awb-shipper', '#awb-consignee', '#awb-origin', '#awb-destination'];
  if (required.some((selector) => !document.querySelector(selector).value.trim())) {
    showToast('Complete the AWB details');
    return;
  }
  const awb = {
    number: normalizeAwb(document.querySelector('#awb-number').value),
    carrier: document.querySelector('#awb-carrier').value.trim(),
    shipper: document.querySelector('#awb-shipper').value.trim(),
    consignee: document.querySelector('#awb-consignee').value.trim(),
    origin: document.querySelector('#awb-origin').value.trim(),
    destination: document.querySelector('#awb-destination').value.trim(),
    date: document.querySelector('#awb-date').value,
    flight: document.querySelector('#awb-flight').value.trim(),
    savedAt: new Date().toISOString()
  };
  saveAwbRecord(awb.number, {
    masterAwb: awb
  });
  document.querySelector('#awb-search').value = awb.number || '';
  syncGlobalAwbSearch(awb.number || '');
  showToast('Master AWB captured');
});

document.querySelector('#new-invoice').addEventListener('click', () => showToast('Invoice workspace ready'));
document.querySelector('#booking-search')?.addEventListener('input', renderStoredBookings);
document.querySelector('#clear-all-bookings')?.addEventListener('click', () => {
  localStorage.setItem('liftline-bookings', JSON.stringify([]));
  localStorage.setItem('liftline-awb-records', JSON.stringify({}));
  localStorage.setItem('liftline-master-awbs', JSON.stringify([]));
  renderStoredBookings();
  renderSearchBookingsPage();
  updateShipmentCount();
  showToast('All bookings cleared');
});
document.querySelectorAll('.filter-pill').forEach((filter) => {
  filter.addEventListener('click', () => {
    document.querySelector('.filter-pill.active').classList.remove('active');
    filter.classList.add('active');
    showToast(`${filter.textContent} selected`);
  });
});
renderStoredBookings();