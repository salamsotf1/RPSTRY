const path = require('path');

function emit(event) {
  process.stdout.write(`AIR_CARGO_TEST_EVENT ${JSON.stringify(event)}\n`);
}

function screenFor(title) {
  if (/Master AWB|AWB number search/i.test(title)) return 'Global AWB / Master AWB';
  if (/saved bookings|deleting saved bookings/i.test(title)) return 'Billing / Saved Bookings';
  return 'New Booking';
}

class DashboardReporter {
  onBegin(config, suite) {
    this.startedAt = Date.now();
    this.total = suite.allTests().length;
    emit({ type: 'suite-begin', total: this.total });
  }

  onTestBegin(test) {
    emit({ type: 'test-begin', id: test.id, title: test.title, screen: screenFor(test.title) });
  }

  onTestEnd(test, result) {
    emit({
      type: 'test-end',
      id: test.id,
      title: test.title,
      screen: screenFor(test.title),
      status: result.status,
      duration: result.duration,
      error: result.errors?.[0]?.message || '',
      attachments: (result.attachments || [])
        .filter((attachment) => attachment.path)
        .map((attachment) => ({
          name: attachment.name,
          contentType: attachment.contentType,
          path: path.relative(process.cwd(), attachment.path)
        }))
    });
  }

  onEnd(result) {
    emit({ type: 'suite-end', status: result.status, duration: Date.now() - this.startedAt });
  }
}

module.exports = DashboardReporter;
