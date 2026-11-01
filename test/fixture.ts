import { parseActivities } from "../src/activities.ts";
import type { ActivitiesConfig } from "../src/activities.ts";

/**
 * One effect on sale, for tests that pin an exact RCON line.
 *
 * The shipped catalogue sells eight equally priced 15 second events and draws them at random, so a
 * test asserting a specific command against it would be testing the dice, not the pipeline. This
 * fixture keeps the shape those tests were written for: one 50 RUB step buys one effect, the effect
 * carries a clock in `params` and accepts a nickname. The real catalogue has its own tests.
 */
export function onSaleCatalogue(): ActivitiesConfig {
  return parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    defaultCooldownSec: 60,
    activities: [
      {
        code: "he_party",
        title: "HE party",
        announce: "HE PARTY!",
        price: 50,
        priority: 10,
        duration: "seconds",
        seconds: 60,
        rounds: null,
        cooldownSec: 0,
        globalCooldownSec: 0,
        enabled: true,
        params: { seconds: 60, maxNameLength: 16 },
      },
      {
        // Off sale on purpose: it is the instant effect the plan/merge tests need.
        code: "chaos_burst",
        title: "Chaos now",
        announce: "CHAOS INCOMING!",
        price: 140,
        priority: 0,
        duration: "instant",
        rounds: null,
        cooldownSec: 30,
        globalCooldownSec: 0,
        enabled: false,
        params: {},
      },
      {
        // Retired effects a test can switch on with one patch.
        code: "bot_phrase",
        title: "Bot says it",
        announce: "A BOT SPEAKS!",
        price: 65,
        priority: 0,
        duration: "instant",
        rounds: null,
        cooldownSec: 20,
        globalCooldownSec: 0,
        enabled: false,
        params: { maxPhraseLength: 40 },
      },
      {
        code: "bless_bot",
        title: "Bless a bot",
        announce: "A BOT IS BLESSED!",
        price: 55,
        priority: 0,
        duration: "instant",
        rounds: null,
        cooldownSec: 20,
        globalCooldownSec: 0,
        enabled: false,
        params: { health: 250, weapon: "weapon_deagle", maxNameLength: 16 },
      },
      {
        code: "knives_only",
        title: "Knives only",
        announce: "KNIVES ONLY!",
        price: 75,
        priority: 0,
        duration: "rounds",
        rounds: 1,
        cooldownSec: 60,
        globalCooldownSec: 0,
        enabled: false,
        params: {},
      },
      {
        code: "awp_only",
        title: "AWP only",
        announce: "AWP ONLY!",
        price: 100,
        priority: 0,
        duration: "rounds",
        rounds: 1,
        cooldownSec: 60,
        globalCooldownSec: 0,
        enabled: false,
        params: {},
      },
      {
        code: "map_change",
        title: "Map change",
        announce: "MAP CHANGE BY DONATION!",
        price: 250,
        priority: 0,
        duration: "instant",
        rounds: null,
        cooldownSec: 60,
        globalCooldownSec: 600,
        enabled: false,
        params: { maps: ["fy_iceworld", "fy_pool_day", "fy_snow", "fy_buzzkill", "fy_aztec", "fy_dustworld"] },
      },
    ],
  });
}
