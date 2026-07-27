export interface IntegrationProvider {
  /** Fetch the current-period spend in USD. */
  fetchSpendUSD(config: Record<string, any>): Promise<number>;

  /**
   * Fetch the current budget cap / alert threshold, if the provider exposes one.
   * Return shape is provider-specific (see e.g. RailwayUsageLimits) — callers that
   * want the cap duck-type on `computeHardLimitUSD` / `computeSoftLimitUSD`.
   */
  fetchLimitsUSD?(config: Record<string, any>): Promise<Record<string, any> | null>;
}
