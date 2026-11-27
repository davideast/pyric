import 'dart:convert';

import 'package:flutter/material.dart';

import 'pyric_debug_controller.dart';
import 'rules_denial_report.dart';
import 'sandbox_user_record.dart';

/// A diagnostic card rendering a Security Rules evaluation failure (CEL rejection).
class RulesDenialCard extends StatefulWidget {
  final RulesDenialReport report;
  final PyricDebugController controller;

  const RulesDenialCard({
    super.key,
    required this.report,
    required this.controller,
  });

  @override
  State<RulesDenialCard> createState() => _RulesDenialCardState();
}

class _RulesDenialCardState extends State<RulesDenialCard> {
  bool _isExpanded = false;

  @override
  Widget build(BuildContext context) {
    final report = widget.report;

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.red.withAlpha(80), width: 1.5),
      ),
      elevation: 2,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header: Error Code and Citation
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.red.withAlpha(30),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.gpp_bad, color: Colors.red, size: 14),
                      const SizedBox(width: 4),
                      Text(
                        report.isStorage
                            ? (report.errorCode ?? 'storage/unauthorized')
                            : 'PERMISSION_DENIED',
                        style: const TextStyle(
                          color: Colors.red,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        report.citation,
                        overflow: TextOverflow.ellipsis,
                        maxLines: 1,
                        style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 11,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),

            // Rule expression monospace snippet
            if (report.expression != null && report.expression!.isNotEmpty) ...[
              const Text(
                'RULE EXPRESSION',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  color: Colors.grey,
                ),
              ),
              const SizedBox(height: 4),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E1E1E),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  report.expression!,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: Color(0xFFD4D4D4),
                  ),
                ),
              ),
              const SizedBox(height: 10),
            ],

            // Evaluation reasons
            if (report.reasons.isNotEmpty) ...[
              const Text(
                'EVALUATION REASONS',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  color: Colors.grey,
                ),
              ),
              const SizedBox(height: 4),
              ...report.reasons.map(
                (reason) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '- ',
                        style: TextStyle(
                          color: Colors.red,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Expanded(
                        child: Text(
                          reason,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],

            // Collapsible accordion for Request & Resource Context
            InkWell(
              onTap: () {
                setState(() {
                  _isExpanded = !_isExpanded;
                });
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Text(
                      _isExpanded
                          ? 'Hide Evaluation Context'
                          : 'View Evaluation Context',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    Icon(
                      _isExpanded
                          ? Icons.keyboard_arrow_up
                          : Icons.keyboard_arrow_down,
                      size: 16,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ],
                ),
              ),
            ),

            if (_isExpanded) ...[
              const SizedBox(height: 6),
              if (report.requestPath != null)
                _buildDetailRow(
                  'Operation',
                  '${report.requestMethod?.toUpperCase() ?? 'ACCESS'} ${report.requestPath}',
                ),
              if (report.authUid != null)
                _buildDetailRow('Auth UID', report.authUid!),
              if (report.authTenant != null)
                _buildDetailRow('Tenant', report.authTenant!),
              if (report.matchedPath != null && report.matchedPath!.isNotEmpty)
                _buildDetailRow('Matched Path', report.matchedPath!),
              if (report.pathVariableBindings != null &&
                  report.pathVariableBindings!.isNotEmpty)
                _buildDetailRow(
                  'Bindings',
                  report.pathVariableBindings!.entries
                      .map((e) => '${e.key}: ${e.value}')
                      .join(', '),
                ),
              if (report.failedFields.isNotEmpty)
                _buildDetailRow('Failed Fields', report.failedFields.join(', ')),
              if (report.proposedData != null && report.proposedData!.isNotEmpty)
                _buildValueBlock(
                  report.isRtdb
                      ? 'Proposed Value (newData)'
                      : 'Proposed Data (request.resource.data)',
                  report.proposedData!,
                )
              else if (report.proposedValue != null)
                _buildValueBlock(
                  report.isRtdb
                      ? 'Proposed Value (newData)'
                      : 'Proposed Value',
                  report.proposedValue,
                ),
              if (report.existingData != null && report.existingData!.isNotEmpty)
                _buildValueBlock(
                  report.isRtdb
                      ? 'Existing Data (data)'
                      : 'Existing Data (resource.data)',
                  report.existingData!,
                ),
            ],

            const Divider(height: 16),

            // Quick Actions Footer
            Builder(
              builder: (context) {
                final targetUid = _resolveImpersonationTargetUid(report);
                return Row(
                  children: [
                    ElevatedButton.icon(
                      onPressed: () {
                        widget.controller.toggleAdminBypass(true);
                      },
                      icon: const Icon(Icons.shield, size: 14),
                      label: const Text('1-Tap Admin Bypass'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.purple,
                        foregroundColor: Colors.white,
                        textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        minimumSize: Size.zero,
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (targetUid != null)
                      Flexible(
                        child: Align(
                          alignment: Alignment.centerRight,
                          child: OutlinedButton.icon(
                            onPressed: () {
                              final matched = widget.controller.users
                                  .where((u) => u.uid == targetUid)
                                  .firstOrNull;
                              final record = matched ??
                                  SandboxUserRecord(
                                    uid: targetUid,
                                    tenantId: targetUid == report.authUid
                                        ? report.authTenant
                                        : null,
                                    customClaims: targetUid == report.authUid
                                        ? (report.authClaims ?? const {})
                                        : const {},
                                  );
                              widget.controller.selectUser(record);
                            },
                            icon: const Icon(Icons.person, size: 14),
                            label: Text(
                              'Impersonate $targetUid',
                              overflow: TextOverflow.ellipsis,
                              maxLines: 1,
                            ),
                            style: OutlinedButton.styleFrom(
                              textStyle: const TextStyle(fontSize: 11),
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                              minimumSize: Size.zero,
                            ),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  static const List<String> _ownerFieldKeys = <String>[
    'ownerId',
    'ownerUid',
    'userId',
    'authorId',
    'uid',
  ];

  String? _resolveImpersonationTargetUid(RulesDenialReport report) {
    for (final source in <Map<String, dynamic>?>[
      report.existingData,
      report.proposedData,
    ]) {
      if (source == null) continue;
      for (final key in _ownerFieldKeys) {
        final raw = source[key];
        if (raw is String && raw.trim().isNotEmpty) {
          return raw.trim();
        }
      }
    }
    final caller = report.authUid?.trim();
    return (caller != null && caller.isNotEmpty) ? caller : null;
  }

  Widget _buildDetailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 80,
            child: Text(
              '$label:',
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                color: Colors.grey,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 11,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildValueBlock(String title, dynamic value) {
    const encoder = JsonEncoder.withIndent('  ');
    String formatted;
    try {
      formatted = encoder.convert(value);
    } catch (_) {
      formatted = value.toString();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.bold,
              color: Colors.grey,
            ),
          ),
          const SizedBox(height: 2),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: Colors.grey.withAlpha(25),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              formatted,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
