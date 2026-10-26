import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Pushes a fake donation into the mock file that the control API polls (DA_MOCK=1).
 * Works without a DonationAlerts account, so the whole pipeline can be tested for free.
 */
const args = process.argv.slice(2);

function arg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined || value === "" ? fallback : value;
}

const amount = Number(arg("amount", "50"));
const username = arg("user", "TestDonor");
const currency = arg("currency", "RUB").toUpperCase();
const file = process.env["DA_MOCK_FILE"] ?? "data/mock-donations.json";

if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`--amount must be a positive number, got "${arg("amount", "50")}"`);
  process.exit(1);
}

interface MockDonation {
  id: number;
  username: string;
  amount: number;
  currency: string;
  message: string | null;
  createdAt: string;
}

function read(filePath: string): MockDonation[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(raw) ? (raw as MockDonation[]) : [];
  } catch {
    return [];
  }
}

const donations = read(file);
const nextId = donations.reduce((max, donation) => Math.max(max, donation.id), 0) + 1;
const donation: MockDonation = {
  id: nextId,
  username,
  amount,
  currency,
  message: arg("message", ""),
  createdAt: new Date().toISOString(),
};

donations.push(donation);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(donations, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ event: "mock.donation", file, donation }));
