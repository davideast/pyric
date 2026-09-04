import 'package:flutter/material.dart';

import 'pyric_debug_controller.dart';
import 'rules_denial_card.dart';
import 'sandbox_user_record.dart';

/// Modal bottom sheet containing Identity Impersonation controls and CEL Denial diagnostics.
class PyricDebugSheet extends StatefulWidget {
  final PyricDebugController controller;

  const PyricDebugSheet({
    super.key,
    required this.controller,
  });

  @override
  State<PyricDebugSheet> createState() => _PyricDebugSheetState();
}

class _PyricDebugSheetState extends State<PyricDebugSheet>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.controller.users.isEmpty) {
        widget.controller.refreshUsers();
      }
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final denialsCount = widget.controller.denials.length;

        return DraggableScrollableSheet(
          initialChildSize: 0.75,
          minChildSize: 0.4,
          maxChildSize: 0.95,
          expand: false,
          builder: (context, scrollController) {
            return Container(
              decoration: BoxDecoration(
                color: Theme.of(context).scaffoldBackgroundColor,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
              ),
              child: Column(
                children: [
                  // Handle bar
                  Center(
                    child: Container(
                      margin: const EdgeInsets.symmetric(vertical: 8),
                      width: 36,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.grey.withAlpha(100),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),

                  // Header title and actions
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                    child: Row(
                      children: [
                        const Text(
                          'Pyric Companion',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const Spacer(),
                        if (_tabController.index == 0)
                          IconButton(
                            icon: widget.controller.isLoadingUsers
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(Icons.refresh),
                            onPressed: widget.controller.isLoadingUsers
                                ? null
                                : () => widget.controller.refreshUsers(),
                          )
                        else if (denialsCount > 0)
                          TextButton(
                            onPressed: () => widget.controller.clearDenials(),
                            child: const Text('Clear'),
                          ),
                        IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ],
                    ),
                  ),

                  // Tab bar
                  TabBar(
                    controller: _tabController,
                    onTap: (_) => setState(() {}),
                    tabs: [
                      const Tab(text: 'Identity & Impersonation'),
                      Tab(
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text('Rules Denials'),
                            if (denialsCount > 0) ...[
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: Colors.red,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(
                                  '$denialsCount',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),

                  // Tab Views
                  Expanded(
                    child: TabBarView(
                      controller: _tabController,
                      children: [
                        _buildIdentityTab(scrollController),
                        _buildDenialsTab(scrollController),
                      ],
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildIdentityTab(ScrollController scrollController) {
    final filteredUsers = widget.controller.users.where((u) {
      if (_searchQuery.isEmpty) return true;
      final q = _searchQuery.toLowerCase();
      return (u.email?.toLowerCase().contains(q) ?? false) ||
          (u.displayName?.toLowerCase().contains(q) ?? false) ||
          u.uid.toLowerCase().contains(q);
    }).toList();

    return ListView(
      controller: scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      children: [
        // Admin Bypass Switch
        Card(
          child: SwitchListTile(
            title: const Row(
              children: [
                Text(
                  'Admin Bypass',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                SizedBox(width: 6),
                Icon(Icons.shield, color: Colors.purple, size: 18),
              ],
            ),
            subtitle: const Text(
              'Bypasses all Firestore Security Rules',
              style: TextStyle(fontSize: 12),
            ),
            value: widget.controller.isAdminBypass,
            activeThumbColor: Colors.purple,
            onChanged: (enabled) {
              widget.controller.toggleAdminBypass(enabled);
            },
          ),
        ),
        const SizedBox(height: 8),

        // Quick Modes
        Card(
          child: Column(
            children: [
              ListTile(
                leading: const Icon(Icons.person_off),
                title: const Text('Anonymous (Signed Out)'),
                trailing: widget.controller.currentLens.mode == 'anon'
                    ? const Icon(Icons.check, color: Colors.blue)
                    : null,
                onTap: () => widget.controller.selectAnon(),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.desktop_windows),
                title: const Text('App Session (Mirror Browser)'),
                trailing: widget.controller.currentLens.mode == 'app-session'
                    ? const Icon(Icons.check, color: Colors.blue)
                    : null,
                onTap: () => widget.controller.selectAppSession(),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),

        // Search Bar
        TextField(
          controller: _searchController,
          decoration: InputDecoration(
            hintText: 'Search by email, name, or UID',
            prefixIcon: const Icon(Icons.search),
            isDense: true,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            suffixIcon: _searchQuery.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.clear),
                    onPressed: () {
                      _searchController.clear();
                      setState(() => _searchQuery = '');
                    },
                  )
                : null,
          ),
          onChanged: (val) {
            setState(() => _searchQuery = val);
          },
        ),
        const SizedBox(height: 12),

        // Sandbox Users List
        Text(
          'Sandbox Users (${filteredUsers.length})',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
        ),
        const SizedBox(height: 6),

        if (filteredUsers.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Center(
              child: Text(
                widget.controller.users.isEmpty
                    ? 'No sandbox users found. Create one in Pyric Studio.'
                    : 'No users matching "$_searchQuery"',
                style: const TextStyle(color: Colors.grey),
              ),
            ),
          )
        else
          ...filteredUsers.map((user) => _buildUserTile(user)),
      ],
    );
  }

  Widget _buildUserTile(SandboxUserRecord user) {
    final isSelected = widget.controller.currentLens.mode == 'as' &&
        widget.controller.currentLens.uid == user.uid;

    final initial = user.displayName?.isNotEmpty == true
        ? user.displayName![0].toUpperCase()
        : user.email?.isNotEmpty == true
            ? user.email![0].toUpperCase()
            : user.uid.isNotEmpty
                ? user.uid[0].toUpperCase()
                : 'U';

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      elevation: isSelected ? 3 : 1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: isSelected
            ? const BorderSide(color: Colors.blue, width: 2)
            : BorderSide.none,
      ),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: isSelected ? Colors.blue : Colors.grey.withAlpha(50),
          foregroundColor: isSelected ? Colors.white : Colors.black87,
          child: Text(initial, style: const TextStyle(fontWeight: FontWeight.bold)),
        ),
        title: Text(
          user.displayName ?? user.email ?? user.uid,
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (user.email != null && user.displayName != null)
              Text(user.email!, style: const TextStyle(fontSize: 12)),
            Row(
              children: [
                Text(
                  user.uid,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: Colors.grey,
                  ),
                ),
                if (user.tenantId != null && user.tenantId!.isNotEmpty) ...[
                  const SizedBox(width: 4),
                  Text(
                    '• ${user.tenantId}',
                    style: const TextStyle(fontSize: 11, color: Colors.purple),
                  ),
                ],
              ],
            ),
            if (user.customClaims.isNotEmpty) ...[
              const SizedBox(height: 4),
              Wrap(
                spacing: 4,
                runSpacing: 2,
                children: user.customClaims.entries.map((e) {
                  return Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    decoration: BoxDecoration(
                      color: Colors.blue.withAlpha(30),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '${e.key}: ${e.value}',
                      style: const TextStyle(fontSize: 9),
                    ),
                  );
                }).toList(),
              ),
            ],
          ],
        ),
        trailing: isSelected
            ? const Icon(Icons.check_circle, color: Colors.blue)
            : null,
        onTap: () {
          widget.controller.selectUser(user);
        },
      ),
    );
  }

  Widget _buildDenialsTab(ScrollController scrollController) {
    if (widget.controller.denials.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.verified_user, color: Colors.green, size: 56),
            SizedBox(height: 12),
            Text(
              'Zero Rules Denials',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            SizedBox(height: 4),
            Text(
              'All Firestore operations evaluated cleanly against Security Rules.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      controller: scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      itemCount: widget.controller.denials.length,
      itemBuilder: (context, index) {
        final report = widget.controller.denials[index];
        return RulesDenialCard(
          report: report,
          controller: widget.controller,
        );
      },
    );
  }
}
