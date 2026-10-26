import type { ActivitiesConfig, Activity } from "./activities.ts";

/**
 * Donation -> activity resolution.
 *
 * Deterministic on purpose: we take the most expensive enabled activity whose
 * price fits the amount, so the catalogue does not need viewer input.
 * Tie on price is broken by `priority` (higher wins), then by code (alphabetical),
 * which keeps later additions stable.
 */
export type RejectReason =
  | "invalid_amount"
  | "below_minimum"
  | "unsupported_currency"
  | "no_activity";

export interface DonationInput {
  amount: number | string;
  currency: string;
}

export type Resolution =
  | { kind: "activate"; activity: Activity; amount: number }
  | { kind: "reject"; reason: RejectReason; amount: number | null; currency: string | null };

function parseAmount(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidatesFor(config: ActivitiesConfig, amount: number): Activity[] {
  return config.activities
    .filter((activity) => activity.enabled && activity.price <= amount)
    .sort((left, right) => {
      if (right.price !== left.price) return right.price - left.price;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.code.localeCompare(right.code);
    });
}

export function resolveDonation(donation: DonationInput, config: ActivitiesConfig): Resolution {
  const amount = parseAmount(donation.amount);
  const currency = typeof donation.currency === "string" ? donation.currency.trim().toUpperCase() : null;

  if (amount === null || amount <= 0) {
    return { kind: "reject", reason: "invalid_amount", amount, currency };
  }
  if (currency !== config.currency) {
    return { kind: "reject", reason: "unsupported_currency", amount, currency };
  }
  if (amount < config.minAmount) {
    return { kind: "reject", reason: "below_minimum", amount, currency };
  }

  const [best] = candidatesFor(config, amount);
  if (!best) {
    return { kind: "reject", reason: "no_activity", amount, currency };
  }

  return { kind: "activate", activity: best, amount };
}
