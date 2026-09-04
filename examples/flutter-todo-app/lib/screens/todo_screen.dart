import 'package:flutter/material.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import '../models/todo_item.dart';
import '../services/todo_repository.dart';

/// Primary Todo application screen featuring live stream, auth state, and rules diagnostics.
class TodoScreen extends StatefulWidget {
  final TodoRepository repository;

  const TodoScreen({
    super.key,
    required this.repository,
  });

  @override
  State<TodoScreen> createState() => _TodoScreenState();
}

class _TodoScreenState extends State<TodoScreen> {
  final TextEditingController _textController = TextEditingController();
  String? _effectiveUid;
  String? _userDisplay;

  @override
  void initState() {
    super.initState();
    _initAuthListener();
  }

  void _initAuthListener() {
    final auth = FirebaseAuthPlatform.instance;
    if (auth is PyricFirebaseAuthPlatform) {
      auth.authLensChanges.listen((lens) {
        if (!mounted) return;
        setState(() {
          _updateEffectiveIdentity(lens, auth.currentUser);
        });
      });
    }

    auth.authStateChanges().listen((user) {
      if (!mounted) return;
      setState(() {
        final lens = (auth is PyricFirebaseAuthPlatform)
            ? auth.currentAuthLens
            : AuthLens.anon;
        _updateEffectiveIdentity(lens, user);
      });
    });
  }

  void _updateEffectiveIdentity(AuthLens lens, UserPlatform? user) {
    if (lens.mode == 'as' && lens.uid != null) {
      _effectiveUid = lens.uid;
      _userDisplay = lens.uid;
    } else if (lens.mode == 'admin') {
      _effectiveUid = user?.uid ?? 'admin';
      _userDisplay = 'ADMIN';
    } else if (user != null) {
      _effectiveUid = user.uid;
      _userDisplay = user.email ?? user.displayName ?? user.uid;
    } else {
      _effectiveUid = null;
      _userDisplay = null;
    }
  }

  Future<void> _addTodo() async {
    final title = _textController.text.trim();
    if (title.isEmpty || _effectiveUid == null) return;
    _textController.clear();
    try {
      await widget.repository.addTodo(title, _effectiveUid!);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to add todo: $e')),
        );
      }
    }
  }

  Future<void> _triggerUnauthorizedWrite() async {
    try {
      await widget.repository.triggerUnauthorizedWrite();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Rules check triggered (Expected): $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = FirebaseAuthPlatform.instance;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Pyric Flutter Todos'),
        actions: [
          IconButton(
            icon: const Icon(Icons.shield, color: Colors.redAccent),
            tooltip: 'Trigger Unauthorized Write (Verify Security Rules)',
            onPressed: _triggerUnauthorizedWrite,
          ),
        ],
      ),
      body: _effectiveUid == null
          ? _buildUnauthenticatedView(auth)
          : _buildAuthenticatedView(),
    );
  }

  Widget _buildUnauthenticatedView(FirebaseAuthPlatform auth) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.lock_outline, size: 64, color: Colors.orange),
            const SizedBox(height: 16),
            const Text(
              'Authentication Required',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            const Text(
              'Firestore security rules require:\nallow read, write: if request.auth.uid == resource.data.userId;',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.black54),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              icon: const Icon(Icons.person),
              label: const Text('Sign In Anonymously'),
              onPressed: () async {
                try {
                  await auth.signInAnonymously();
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Sign-in failed: $e')),
                    );
                  }
                }
              },
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              icon: const Icon(Icons.email),
              label: const Text('Sign In as Alice (Email/Password)'),
              onPressed: () async {
                try {
                  await auth.signInWithEmailAndPassword('alice@example.com', 'password123');
                } catch (e) {
                  final msg = e.toString();
                  if (msg.contains('user-not-found') || msg.contains('No user found')) {
                    try {
                      await auth.createUserWithEmailAndPassword('alice@example.com', 'password123');
                      return;
                    } catch (ce) {
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Sign-in failed: $ce')),
                        );
                      }
                      return;
                    }
                  }
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Sign-in failed: $e')),
                    );
                  }
                }
              },
            ),
            const SizedBox(height: 16),
            const Text(
              'Or tap the Pyric Chip floating above to 1-tap impersonate sandbox users or toggle Admin Bypass.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAuthenticatedView() {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          child: Row(
            children: [
              const Icon(Icons.account_circle, color: Colors.blue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'User: $_userDisplay',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              TextButton(
                onPressed: () => FirebaseAuthPlatform.instance.signOut(),
                child: const Text('Sign Out'),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(12.0),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _textController,
                  decoration: const InputDecoration(
                    hintText: 'What needs to be done?',
                    border: OutlineInputBorder(),
                    contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                  onSubmitted: (_) => _addTodo(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                icon: const Icon(Icons.add),
                onPressed: _addTodo,
              ),
            ],
          ),
        ),
        Expanded(
          child: StreamBuilder<List<TodoItem>>(
            stream: widget.repository.getTodosStream(_effectiveUid!),
            builder: (context, snapshot) {
              if (snapshot.hasError) {
                return Center(
                  child: Text(
                    'Error: ${snapshot.error}',
                    style: const TextStyle(color: Colors.red),
                  ),
                );
              }
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }

              final todos = snapshot.data ?? [];
              if (todos.isEmpty) {
                return const Center(
                  child: Text(
                    'No todos yet for this user.\nAdd one above or switch identity via the chip!',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey),
                  ),
                );
              }

              return ListView.builder(
                itemCount: todos.length,
                itemBuilder: (context, index) {
                  final item = todos[index];
                  return ListTile(
                    leading: Checkbox(
                      value: item.completed,
                      onChanged: (_) {
                        widget.repository.toggleTodo(item.id, item.completed);
                      },
                    ),
                    title: Text(
                      item.title,
                      style: TextStyle(
                        decoration: item.completed
                            ? TextDecoration.lineThrough
                            : TextDecoration.none,
                      ),
                    ),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () {
                        widget.repository.deleteTodo(item.id);
                      },
                    ),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }
}
