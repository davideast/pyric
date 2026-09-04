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
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.gpp_bad, color: Colors.red, size: 14),
                      SizedBox(width: 4),
                      Text(
                        'PERMISSION_DENIED',
                        style: TextStyle(
                          color: Colors.red,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.grey.withAlpha(40),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    report.citation,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: Colors.black87,
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
                        '• ',
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
              if (report.failedFields.isNotEmpty)
                _buildDetailRow('Failed Fields', report.failedFields.join(', ')),
              if (report.proposedData != null && report.proposedData!.isNotEmpty)
                _buildDataBlock(
                  'Proposed Data (request.resource.data)',
                  report.proposedData!,
                ),
              if (report.existingData != null && report.existingData!.isNotEmpty)
                _buildDataBlock(
                  'Existing Data (resource.data)',
                  report.existingData!,
                ),
            ],

            const Divider(height: 16),

            // Quick Actions Footer
            Row(
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
                const Spacer(),
                if (report.authUid != null && report.authUid!.isNotEmpty)
                  OutlinedButton.icon(
                    onPressed: () {
                      final record = SandboxUserRecord(
                        uid: report.authUid!,
                        tenantId: report.authTenant,
                        customClaims: report.authClaims ?? {},
                      );
                      widget.controller.selectUser(record);
                    },
                    icon: const Icon(Icons.person, size: 14),
                    label: Text('Impersonate ${report.authUid}'),
                    style: OutlinedButton.styleFrom(
                      textStyle: const TextStyle(fontSize: 11),
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      minimumSize: Size.zero,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
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

  Widget _buildDataBlock(String title, Map<String, dynamic> data) {
    const encoder = JsonEncoder.withIndent('  ');
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
              encoder.convert(data),
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
