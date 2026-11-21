import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

/// Concrete [ListResultPlatform] backed by resolved [ReferencePlatform] prefixes and items.
class PyricListResultPlatform extends ListResultPlatform {
  final List<ReferencePlatform> _items;
  final List<ReferencePlatform> _prefixes;

  PyricListResultPlatform(
    FirebaseStoragePlatform storage, {
    String? nextPageToken,
    required List<ReferencePlatform> items,
    required List<ReferencePlatform> prefixes,
  })  : _items = List<ReferencePlatform>.unmodifiable(items),
        _prefixes = List<ReferencePlatform>.unmodifiable(prefixes),
        super(storage, nextPageToken);

  @override
  List<ReferencePlatform> get items => _items;

  @override
  List<ReferencePlatform> get prefixes => _prefixes;
}
