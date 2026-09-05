import 'package:flutter/material.dart';

import 'pyric_debug_controller.dart';
import 'pyric_debug_sheet.dart';

/// Floating, draggable pill overlay providing 1-tap identity switching and rules diagnostics.
class PyricDebugOverlay extends StatefulWidget {
  final Widget? child;
  final PyricDebugController? controller;

  const PyricDebugOverlay({
    super.key,
    this.child,
    this.controller,
  });

  @override
  State<PyricDebugOverlay> createState() => _PyricDebugOverlayState();
}

class _PyricDebugOverlayState extends State<PyricDebugOverlay> {
  late PyricDebugController _controller;
  bool _internalController = false;

  Offset _position = const Offset(16, 60);

  @override
  void initState() {
    super.initState();
    if (widget.controller != null) {
      _controller = widget.controller!;
    } else {
      _controller = PyricDebugController();
      _internalController = true;
    }
  }

  @override
  void dispose() {
    if (_internalController) {
      _controller.dispose();
    }
    super.dispose();
  }

  void _showSheet() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) => PyricDebugSheet(controller: _controller),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pill = AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Positioned(
          left: _position.dx,
          top: _position.dy,
          child: GestureDetector(
            onPanUpdate: (details) {
              setState(() {
                final media = MediaQuery.of(context).size;
                final newX = (_position.dx + details.delta.dx).clamp(8.0, media.width - 120.0);
                final newY = (_position.dy + details.delta.dy).clamp(30.0, media.height - 60.0);
                _position = Offset(newX, newY);
              });
            },
            onTap: _showSheet,
            child: Material(
              elevation: 6,
              borderRadius: BorderRadius.circular(20),
              color: const Color(0xFF1E1E1E),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: _controller.denials.isNotEmpty
                        ? Colors.red
                        : _controller.isAdminBypass
                            ? Colors.purple
                            : Colors.white24,
                    width: 1.5,
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _iconForMode(_controller.currentLens.mode),
                      color: _colorForMode(_controller.currentLens.mode),
                      size: 16,
                    ),
                    const SizedBox(width: 6),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 140),
                      child: Text(
                        _controller.activeIdentityTitle,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                        ),
                      ),
                    ),
                    if (_controller.denials.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.red,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          '${_controller.denials.length}',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );

    if (widget.child == null) {
      return pill;
    }

    return Stack(
      children: [
        widget.child!,
        pill,
      ],
    );
  }

  IconData _iconForMode(String mode) {
    switch (mode) {
      case 'admin':
        return Icons.shield;
      case 'as':
        return Icons.person;
      case 'app-session':
        return Icons.desktop_windows;
      default:
        return Icons.person_off;
    }
  }

  Color _colorForMode(String mode) {
    switch (mode) {
      case 'admin':
        return Colors.purple;
      case 'as':
        return Colors.green;
      case 'app-session':
        return Colors.blue;
      default:
        return Colors.grey;
    }
  }
}
