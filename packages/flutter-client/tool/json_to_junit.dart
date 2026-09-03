import 'dart:convert';
import 'dart:io';

String _stripAnsi(String text) {
  return text.replaceAll(RegExp(r'\x1B\[[0-?]*[ -/]*[@-~]'), '');
}

String _escapeXmlAttr(String text) {
  final clean = _stripAnsi(text).replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F]'), '');
  return clean
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
}

String _escapeXmlBody(String text) {
  final clean = _stripAnsi(text).replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F]'), '');
  return clean
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
}

class _ActiveTest {
  final int id;
  final String name;
  final int startTime;
  final List<String> errors = [];

  _ActiveTest({required this.id, required this.name, required this.startTime});
}

class _CompletedTestCase {
  final String name;
  final String timeSec;
  final bool failed;
  final String? failureMessage;
  final String failureAttr;

  _CompletedTestCase({
    required this.name,
    required this.timeSec,
    required this.failed,
    this.failureMessage,
    this.failureAttr = 'Failed',
  });
}

void main() async {
  final activeTests = <int, _ActiveTest>{};
  final testCases = <_CompletedTestCase>[];

  await stdin
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .forEach((line) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) return;

    try {
      final event = jsonDecode(trimmed) as Map<String, dynamic>;
      final type = event['type'] as String?;

      if (type == 'testStart') {
        final test = event['test'] as Map<String, dynamic>?;
        if (test != null) {
          final id = test['id'] as int?;
          final name = test['name'] as String? ?? '';
          final time = event['time'] as int? ?? 0;
          if (id != null) {
            activeTests[id] = _ActiveTest(id: id, name: name, startTime: time);
          }
        }
      } else if (type == 'error') {
        final testId = event['testID'] as int?;
        if (testId != null && activeTests.containsKey(testId)) {
          final errStr = event['error']?.toString();
          if (errStr != null && errStr.isNotEmpty) {
            activeTests[testId]!.errors.add(errStr);
          }
        }
      } else if (type == 'testDone') {
        final testId = event['testID'] as int?;
        final hidden = event['hidden'] as bool? ?? false;
        final skipped = event['skipped'] as bool? ?? false;
        final result = event['result'] as String?;
        final endTime = event['time'] as int? ?? 0;

        if (testId != null && activeTests.containsKey(testId)) {
          final active = activeTests.remove(testId)!;
          final isLoader = active.name.startsWith('loading ');

          if (isLoader) {
            final isFail = result == 'failure' || result == 'error' || active.errors.isNotEmpty;
            if (isFail) {
              final failureMessage = active.errors.isNotEmpty
                  ? active.errors.join('\n')
                  : 'Compilation failed';
              testCases.add(_CompletedTestCase(
                name: active.name,
                timeSec: '0.000',
                failed: true,
                failureMessage: failureMessage,
                failureAttr: 'Compilation failed',
              ));
            }
          } else if (!hidden && active.name.isNotEmpty) {
            final isFail = skipped || result == 'failure' || result == 'error' || active.errors.isNotEmpty;
            final durationMs = (endTime - active.startTime).clamp(0, 99999999);
            final timeSec = (durationMs / 1000.0).toStringAsFixed(3);
            final failureMessage = isFail
                ? (skipped
                    ? 'Test was skipped'
                    : (active.errors.isNotEmpty ? active.errors.join('\n') : 'Test failed'))
                : null;
            final failureAttr = skipped ? 'Skipped' : 'Failed';

            testCases.add(_CompletedTestCase(
              name: active.name,
              timeSec: timeSec,
              failed: isFail,
              failureMessage: failureMessage,
              failureAttr: failureAttr,
            ));
          }
        }
      }
    } catch (_) {
      // Ignore non-JSON lines (e.g. pub output or compiler warnings)
    }
  });

  stdout.writeln('<?xml version="1.0" encoding="UTF-8"?>');
  stdout.writeln('<testsuite name="firestore-flutter" tests="${testCases.length}">');
  for (final tc in testCases) {
    final nameAttr = _escapeXmlAttr(tc.name);
    if (tc.failed) {
      final msgBody = _escapeXmlBody(tc.failureMessage ?? 'Failed');
      final failAttr = _escapeXmlAttr(tc.failureAttr);
      stdout.writeln('  <testcase name="$nameAttr" classname="firestore-flutter" time="${tc.timeSec}">');
      stdout.writeln('    <failure message="$failAttr">$msgBody</failure>');
      stdout.writeln('  </testcase>');
    } else {
      stdout.writeln('  <testcase name="$nameAttr" classname="firestore-flutter" time="${tc.timeSec}" />');
    }
  }
  stdout.writeln('</testsuite>');
}
