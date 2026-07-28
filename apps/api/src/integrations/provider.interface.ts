export interface UsageBreakdownItem {
  measurement: string;
  amountUSD: number;
  rawValue: number;
}

export interface ProjectBreakdownItem {
  projectId: string;
  projectName: string;
  amountUSD: number;
}

export interface SpendResult {
  amountUSD: number;
  /** Per-measurement breakdown, if the provider can report one (e.g. Railway's CPU/memory split). */
  breakdown?: UsageBreakdownItem[];
  /** Per-project breakdown, if the provider can report one. */
  byProject?: ProjectBreakdownItem[];
}

export interface IntegrationProvider {
  /** Fetch the current-period spend in USD, with a breakdown if the provider supports one. */
  fetchSpendUSD(config: Record<string, any>): Promise<SpendResult>;

  /**
   * Fetch the current budget cap / alert threshold, if the provider exposes one.
   * Return shape is provider-specific (see e.g. RailwayUsageLimits) - callers that
   * want the cap duck-type on `computeHardLimitUSD` / `computeSoftLimitUSD`.
   */
  fetchLimitsUSD?(config: Record<string, any>): Promise<Record<string, any> | null>;

  /**
   * Fetch spend in USD for an arbitrary past window, if the provider exposes usage
   * history - with a breakdown by measurement (provider-specific keys, e.g. Railway's
   * CPU_USAGE / MEMORY_USAGE_GB) and by project, so callers can show where the spend
   * came from.
   */
  fetchHistoricalSpendUSD?(
    config: Record<string, any>,
    range: { startDate: Date; endDate: Date },
  ): Promise<{ amountUSD: number; breakdown: UsageBreakdownItem[]; byProject: ProjectBreakdownItem[] }>;
}
