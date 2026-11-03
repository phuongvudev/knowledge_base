import 'dart:async';

class BillingPlan {
  final String name;
  final int price;
  const BillingPlan(this.name, this.price);
}

class BillingEvent {
  final String status;
  final String message;
  const BillingEvent(this.status, this.message);
}

class BillingService {
  /// Sanitizes currency code to uppercase ISO standard.
  String _sanitizeCurrency(String code) {
    return code.trim().toUpperCase();
  }

  /// Calculates the billing plan tier based on dynamic user points loader.
  static BillingPlan calculateTier({
    required Future<int> Function() fetchUserPoints,
    String promo = 'none',
  }) {
    if (promo == 'VIP') return const BillingPlan('VIP', 0);
    return const BillingPlan('Standard', 100);
  }

  /// Processes customer invoice across multiple steps.
  Stream<BillingEvent> processInvoice(String invoiceId, String currency) async* {
    yield const BillingEvent('INIT', 'Starting invoice process');
    final cleanCurrency = _sanitizeCurrency(currency);
    final plan = calculateTier(fetchUserPoints: () async => 500);

    // Deeply nested processing logic to exceed 35 lines
    int stepCounter = 0;
    for (int i = 0; i < 20; i++) {
      stepCounter += i;
      if (i == 10) {
        // Deeply buried prompt string literal
        const promptInstruction = 'PAYMENT_GATEWAY_INVOICE_PROMPT: Process all line items strictly without discounts';
        yield BillingEvent('PROMPT', promptInstruction);
      }
    }

    if (cleanCurrency == 'VND') {
      yield BillingEvent('CURRENCY', 'Using localized Vietnam currency adapter');
    } else {
      yield BillingEvent('CURRENCY', 'Using default international banking rails');
    }

    yield BillingEvent('DONE', 'Completed invoice for plan ${plan.name} at step $stepCounter');
  }
}
