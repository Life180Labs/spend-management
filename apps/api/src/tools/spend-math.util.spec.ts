import { monthlyEquivalentSpend } from './spend-math.util';

describe('monthlyEquivalentSpend', () => {
  it('returns usedAmount for PREPAID (usage-based) tools regardless of monthlyAmount', () => {
    const result = monthlyEquivalentSpend({
      paymentKind: 'PREPAID',
      billingCycle: 'MONTHLY',
      usedAmount: 42.5,
      monthlyAmount: 999,
    });
    expect(result).toBe(42.5);
  });

  it('returns usedAmount for CAPSUB (usage-based) tools regardless of monthlyAmount', () => {
    const result = monthlyEquivalentSpend({
      paymentKind: 'CAPSUB',
      billingCycle: 'MONTHLY',
      usedAmount: 17,
      monthlyAmount: 999,
    });
    expect(result).toBe(17);
  });

  it('returns monthlyAmount as-is for MOSUB with a MONTHLY billing cycle', () => {
    const result = monthlyEquivalentSpend({
      paymentKind: 'MOSUB',
      billingCycle: 'MONTHLY',
      usedAmount: 0,
      monthlyAmount: 20,
    });
    expect(result).toBe(20);
  });

  it('pro-rates monthlyAmount by /12 for MOSUB with a YEARLY billing cycle', () => {
    const result = monthlyEquivalentSpend({
      paymentKind: 'MOSUB',
      billingCycle: 'YEARLY',
      usedAmount: 0,
      monthlyAmount: 120,
    });
    expect(result).toBeCloseTo(10, 5);
  });

  it('treats a missing/null billingCycle as MONTHLY (no pro-ration)', () => {
    const result = monthlyEquivalentSpend({
      paymentKind: 'MOSUB',
      billingCycle: null,
      usedAmount: 0,
      monthlyAmount: 20,
    });
    expect(result).toBe(20);
  });

  it('treats a falsy usedAmount/monthlyAmount as 0 rather than NaN', () => {
    expect(
      monthlyEquivalentSpend({
        paymentKind: 'PREPAID',
        billingCycle: 'MONTHLY',
        usedAmount: undefined as any,
        monthlyAmount: 0,
      }),
    ).toBe(0);
    expect(
      monthlyEquivalentSpend({
        paymentKind: 'MOSUB',
        billingCycle: 'YEARLY',
        usedAmount: 0,
        monthlyAmount: undefined as any,
      }),
    ).toBe(0);
  });
});
