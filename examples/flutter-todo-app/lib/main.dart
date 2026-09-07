import 'package:flutter/material.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'screens/todo_screen.dart';
import 'services/todo_repository.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Pyric pure-Dart platform adapters with a shared bridge client
  final auth = PyricFirebaseAuthPlatform();
  FirebaseAuthPlatform.instance = auth;
  PyricFirestorePlatform.registerWith(
    bridgeClient: auth.bridgeClient,
    credentialsProvider: auth,
  );
  PyricDatabase.registerWith(
    bridgeClient: auth.bridgeClient,
    credentialsProvider: auth,
  );

  final debugController = PyricDebugController();
  final repository = TodoRepository();

  runApp(
    TodoApp(
      debugController: debugController,
      repository: repository,
    ),
  );
}

class TodoApp extends StatelessWidget {
  final PyricDebugController debugController;
  final TodoRepository repository;

  const TodoApp({
    super.key,
    required this.debugController,
    required this.repository,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pyric Flutter Todos',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6750A4),
          brightness: Brightness.light,
        ),
      ),
      builder: (context, child) {
        return PyricDebugOverlay(
          controller: debugController,
          child: child,
        );
      },
      home: TodoScreen(repository: repository),
    );
  }
}
