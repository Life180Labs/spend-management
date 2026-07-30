import { advancePeriodUntilAfter } from './renewal-cycle.util';

describe('advancePeriodUntilAfter', () => {
  it('does not advance a date that is already on/after untilAfter', () => {
    const date = new Date(2026, 6, 15); // Jul 15 2026
    const untilAfter = new Date(2026, 6, 1); // Jul 1 2026
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'MONTHLY');
    expect(completedCycles).toEqual([]);
    expect(next).toEqual(date);
  });

  it('advances a MONTHLY date by one month when it is one cycle behind', () => {
    const date = new Date(2026, 5, 15); // Jun 15 2026
    const untilAfter = new Date(2026, 6, 1); // Jul 1 2026
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'MONTHLY');
    expect(completedCycles).toEqual([date]);
    expect(next).toEqual(new Date(2026, 6, 15)); // Jul 15 2026
  });

  it('advances a YEARLY date by one year when it is one cycle behind', () => {
    const date = new Date(2025, 6, 15); // Jul 15 2025
    const untilAfter = new Date(2026, 6, 1); // Jul 1 2026
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'YEARLY');
    expect(completedCycles).toEqual([date]);
    expect(next).toEqual(new Date(2026, 6, 15)); // Jul 15 2026
  });

  it('clamps the day for MONTHLY when the target month is shorter (Jan 31 -> Feb 28)', () => {
    const date = new Date(2026, 0, 31); // Jan 31 2026
    const untilAfter = new Date(2026, 1, 1); // Feb 1 2026
    const { next } = advancePeriodUntilAfter(date, untilAfter, 'MONTHLY');
    expect(next).toEqual(new Date(2026, 1, 28)); // Feb 28 2026 (2026 is not a leap year)
  });

  it('clamps a leap-day YEARLY date to Feb 28 the following non-leap year', () => {
    const date = new Date(2024, 1, 29); // Feb 29 2024 (leap year)
    const untilAfter = new Date(2025, 0, 1); // Jan 1 2025
    const { next } = advancePeriodUntilAfter(date, untilAfter, 'YEARLY');
    expect(next).toEqual(new Date(2025, 1, 28)); // Feb 28 2025
  });

  it('steps through multiple completed cycles when far behind (catch-up)', () => {
    const date = new Date(2026, 0, 15); // Jan 15 2026
    const untilAfter = new Date(2026, 3, 1); // Apr 1 2026
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'MONTHLY');
    expect(completedCycles).toEqual([
      new Date(2026, 0, 15),
      new Date(2026, 1, 15),
      new Date(2026, 2, 15),
    ]);
    expect(next).toEqual(new Date(2026, 3, 15)); // Apr 15 2026
  });

  it('steps through multiple completed YEARLY cycles when far behind', () => {
    const date = new Date(2022, 6, 1); // Jul 1 2022
    const untilAfter = new Date(2026, 6, 1); // Jul 1 2026
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'YEARLY');
    expect(completedCycles).toEqual([
      new Date(2022, 6, 1),
      new Date(2023, 6, 1),
      new Date(2024, 6, 1),
      new Date(2025, 6, 1),
    ]);
    expect(next).toEqual(new Date(2026, 6, 1));
  });

  it('caps at 60 iterations to guarantee termination on anomalous input', () => {
    const date = new Date(1900, 0, 1);
    const untilAfter = new Date(2026, 0, 1);
    const { completedCycles, next } = advancePeriodUntilAfter(date, untilAfter, 'MONTHLY');
    expect(completedCycles.length).toBe(60);
    // 60 months = 5 years forward from Jan 1900
    expect(next).toEqual(new Date(1905, 0, 1));
  });
});
