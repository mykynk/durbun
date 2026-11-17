bool get canSendToSlack => false;

/// Not available without dart:io.
Future<({int status, String answer})> postToSlack(String webhook, Map<String, Object?> payload) async =>
    (status: 0, answer: 'unsupported');
