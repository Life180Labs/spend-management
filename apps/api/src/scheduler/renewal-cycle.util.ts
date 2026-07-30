/**
 * Adds one billing period (a month, or a year) to `date` at a time until it's
 * on/after `untilAfter`, clamping the day to the last valid day of the target
 * month (e.g. MONTHLY: Jan 31 → Feb 28, not Mar 3; YEARLY: Feb 29 on a leap
 * year → Feb 28 the following year). Returns every intermediate date stepped
 * past (each one a completed billing cycle) alongside the final resulting
 * date. Capped at 60 iterations (5 years of MONTHLY, or 60 years of YEARLY -
 * either way, comfortably beyond any real data anomaly) so it can't loop forever.
 */
export function advancePeriodUntilAfter(
  date: Date,
  untilAfter: Date,
  cycle: string,
): { completedCycles: Date[]; next: Date } {
  const day = date.getDate();
  const completedCycles: Date[] = [];
  let result = date;
  let iterations = 0;

  while (result < untilAfter && iterations < 60) {
    completedCycles.push(result);
    const targetYear = cycle === 'YEARLY' ? result.getFullYear() + 1 : result.getFullYear();
    const targetMonthIndex = cycle === 'YEARLY' ? result.getMonth() : result.getMonth() + 1;
    const daysInTargetMonth = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
    result = new Date(targetYear, targetMonthIndex, Math.min(day, daysInTargetMonth));
    iterations++;
  }

  return { completedCycles, next: result };
}
