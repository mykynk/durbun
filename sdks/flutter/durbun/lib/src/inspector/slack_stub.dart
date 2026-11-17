bool get canSendToSlack => false;

/// Not available without dart:io.
Future<({int status, String answer})> postToSlack(String webhook, Map<String, Object?> payload) async =>
    (status: 0, answer: 'unsupported');

/// Not available without dart:io.
Future<({int status, String answer})> postSlackForm(String url, String token, Map<String, String> form) async =>
    (status: 0, answer: 'unsupported');

/// Not available without dart:io.
Future<({int status, String answer})> postSlackBytes(String url, List<int> bytes) async => (status: 0, answer: 'unsupported');
