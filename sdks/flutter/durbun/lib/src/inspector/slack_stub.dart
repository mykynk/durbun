bool get canSendToSlack => false;

/// Not available without dart:io.
Future<String?> postToSlack(String webhook, String text) async => 'unsupported';
