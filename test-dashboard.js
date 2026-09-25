const state = { tests: new Map(), total: 0, startedAt: 0, events: 0 };
const screenNames = ['New Booking', 'Billing / Saved Bookings', 'Global AWB / Master AWB'];
const runButton = document.querySelector('#run-tests');
const eventSource = new EventSource('/api/test-events');

function $(selector) { return document.querySelector(selector); }

function resetRun() {
  state.tests.clear();
  state.total = 0;
  state.startedAt = Date.now();
  state.events = 0;
  $('#test-list').innerHTML = '';
  $('#run-status').textContent = 'Starting test run...';
  $('#last-run').textContent = 'Live';
  $('#status-dot').className = 'status-dot running';
  runButton.disabled = true;
  render();
}

function formatDuration(milliseconds) {
  if (!milliseconds) return '0s';
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function handleEvent(event) {
  state.events += 1;
  if (event.type === 'run-start') resetRun();
  if (event.type === 'suite-begin') state.total = event.total;
  if (event.type === 'test-begin') {
    state.tests.set(event.id, { ...event, status: 'running' });
  }
  if (event.type === 'test-end') {
    state.tests.set(event.id, { ...state.tests.get(event.id), ...event });
  }
  if (event.type === 'suite-end') {
    $('#run-status').textContent = event.status === 'passed' ? 'All tests passed' : 'Tests need attention';
    $('#status-dot').className = `status-dot ${event.status === 'passed' ? 'passed' : 'failed'}`;
    $('#last-run').textContent = `Completed ${new Date().toLocaleTimeString()}`;
    runButton.disabled = false;
    $('#duration-count').textContent = formatDuration(event.duration);
  }
  render();
}

eventSource.addEventListener('test', (message) => {
  try { handleEvent(JSON.parse(message.data)); } catch (error) { console.error(error); }
});

eventSource.onerror = () => {
  $('#run-status').textContent = 'Dashboard disconnected from test server';
  $('#status-dot').className = 'status-dot failed';
  runButton.disabled = false;
};

runButton.addEventListener('click', async () => {
  resetRun();
  const response = await fetch('/api/run-tests', { method: 'POST' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    $('#run-status').textContent = result.error || 'Unable to start tests';
    $('#status-dot').className = 'status-dot failed';
    runButton.disabled = false;
  }
});

function render() {
  const tests = [...state.tests.values()];
  const passed = tests.filter((test) => test.status === 'passed').length;
  const failed = tests.filter((test) => ['failed', 'timedOut', 'interrupted'].includes(test.status)).length;
  $('#total-count').textContent = state.total || tests.length;
  $('#passed-count').textContent = passed;
  $('#failed-count').textContent = failed;
  $('#event-count').textContent = `${state.events} EVENTS`;

  $('#screen-cards').innerHTML = screenNames.map((screen) => {
    const screenTests = tests.filter((test) => test.screen === screen);
    const screenPassed = screenTests.filter((test) => test.status === 'passed').length;
    const percentage = screenTests.length ? Math.round((screenPassed / screenTests.length) * 100) : 0;
    return `<article class="screen-card"><h3>${screen}</h3><div class="screen-count">${screenPassed}/${screenTests.length || 0}</div><small>${screenTests.length ? `${percentage}% passing` : 'Waiting for tests'}</small><div class="screen-bar"><span style="width:${percentage}%"></span></div></article>`;
  }).join('');

  if (!tests.length) {
    $('#test-list').innerHTML = '<div class="empty-state">Run the suite to see live test progress here.</div>';
    return;
  }

  $('#test-list').innerHTML = tests.map((test, index) => `
    <article class="test-row">
      <span class="test-index">${String(index + 1).padStart(2, '0')}</span>
      <div><div class="test-title">${test.title}</div><div class="test-screen">${test.screen}</div></div>
      <span class="test-duration">${formatDuration(test.duration)}</span>
      <button class="test-status ${test.status}" type="button" data-test-id="${test.id}">${test.status}</button>
      <a class="view-details-link" href="#detail-panel" data-test-id="${test.id}">View test details</a>
      <a class="row-screenshot-link" href="${test.attachments?.find((attachment) => attachment.contentType === 'image/png') ? `/${test.attachments.find((attachment) => attachment.contentType === 'image/png').path}` : '#'}" target="_blank" rel="noopener" ${test.attachments?.some((attachment) => attachment.contentType === 'image/png') ? '' : 'aria-disabled="true"'}>Open screenshot</a>
      ${test.error ? `<div class="error-detail">${test.error}</div>` : ''}
    </article>
  `).join('');

  document.querySelectorAll('.test-status').forEach((button) => {
    button.addEventListener('click', () => showDetails(button.dataset.testId));
  });
  document.querySelectorAll('.view-details-link').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      showDetails(link.dataset.testId);
    });
  });
}

function showDetails(testId) {
  const test = state.tests.get(testId);
  if (!test) return;
  const artifacts = (test.attachments || []).filter((attachment) => attachment.contentType === 'image/png' || /screenshot/i.test(attachment.name));
  const artifactMarkup = artifacts.length
    ? artifacts.map((attachment) => `<a class="artifact-link" href="/${attachment.path}" target="_blank" rel="noopener">Open ${attachment.name}</a>`).join('<br>')
    : '<span class="no-artifact">No screenshot captured</span>';
  $('#detail-table-body').innerHTML = `
    <tr><th>TC ID</th><td>${test.id}</td></tr>
    <tr><th>TC description</th><td>${test.title}</td></tr>
    <tr><th>Screen</th><td>${test.screen}</td></tr>
    <tr><th>Status</th><td><span class="test-status ${test.status}">${test.status}</span></td></tr>
    <tr><th>Duration</th><td>${formatDuration(test.duration)}</td></tr>
    <tr><th>Screenshot</th><td>${artifactMarkup}</td></tr>
    ${test.error ? `<tr><th>Error</th><td class="error-detail">${test.error}</td></tr>` : ''}
  `;
  $('#detail-panel').hidden = false;
  $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#close-details').addEventListener('click', () => {
  $('#detail-panel').hidden = true;
});

render();
