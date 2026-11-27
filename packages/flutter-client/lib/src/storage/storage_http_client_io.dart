import 'dart:io';
import 'dart:typed_data';

import 'storage_http_client.dart';

class _IoHttpHandle implements StorageCancelableHttpHandle {
  final HttpClient _client;

  _IoHttpHandle(this._client);

  @override
  void abort() {
    _client.close(force: true);
  }
}

/// Executes a Storage HTTP byte-route request backed by `dart:io` [HttpClient].
Future<StorageRawHttpResponse> performStorageHttpRequest({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  Uint8List? body,
  void Function(StorageCancelableHttpHandle handle)? onHandleCreated,
  void Function()? onHandleClosed,
}) async {
  final client = HttpClient();
  onHandleCreated?.call(_IoHttpHandle(client));
  try {
    final request = await client.openUrl(method, uri);
    headers.forEach(request.headers.set);
    if (body != null) {
      request.contentLength = body.length;
      if (body.isNotEmpty) {
        request.add(body);
      }
    }
    final response = await request.close();
    final bytesBuilder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      bytesBuilder.add(chunk);
    }
    return StorageRawHttpResponse(
      statusCode: response.statusCode,
      body: bytesBuilder.takeBytes(),
    );
  } finally {
    onHandleClosed?.call();
    client.close(force: false);
  }
}
