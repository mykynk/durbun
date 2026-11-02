import 'package:durbun_example/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders the demo buttons (SDK is off inside flutter test)', (tester) async {
    await tester.pumpWidget(const DurbunExampleApp());
    expect(find.text('Dürbün örneği'), findsOneWidget);
    expect(find.text('Tüm seviyeler'), findsOneWidget);
    expect(find.text('GET JSON'), findsOneWidget);
    expect(find.text('Kapalı'), findsOneWidget);
  });
}
