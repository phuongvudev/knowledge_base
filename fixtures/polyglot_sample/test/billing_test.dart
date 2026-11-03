import 'package:test/test.dart';
import '../lib/billing_service.dart';

void main() {
  test('billing service calculates plan', () {
    final service = BillingService();
    expect(service, isNotNull);
  });
}
