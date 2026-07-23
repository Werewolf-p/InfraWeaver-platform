/** @jest-environment node */
// Release-channel table + resolvers (channels.ts). Pure module — no mocks. Pins
// the ids/type/default/guards and the promotion-direction rule the registry
// enforces, so a channel rename or ladder re-order is caught here first.
import {
  CHANNEL_IDS,
  CHANNELS,
  DEFAULT_CHANNEL,
  canPromoteChannel,
  getChannel,
  isReleaseChannel,
  listChannels,
  resolveChannel,
  type ReleaseChannel,
} from "@/addons/wordpress-manager/lib/channels";

describe("channels — ids, table, defaults", () => {
  test("ids are the stable prod/beta/alpha set, prod first", () => {
    expect(CHANNEL_IDS).toEqual(["prod", "beta", "alpha"]);
  });

  test("default channel is prod (the most stable)", () => {
    expect(DEFAULT_CHANNEL).toBe("prod");
    expect(CHANNELS[DEFAULT_CHANNEL].rank).toBe(0);
  });

  test("ranks ascend from prod (0) toward the least-stable channel", () => {
    expect(CHANNELS.prod.rank).toBe(0);
    expect(CHANNELS.beta.rank).toBe(1);
    expect(CHANNELS.alpha.rank).toBe(2);
  });

  test("every id has a table entry whose id matches its key", () => {
    for (const id of CHANNEL_IDS) {
      expect(CHANNELS[id].id).toBe(id);
      expect(typeof CHANNELS[id].label).toBe("string");
      expect(typeof CHANNELS[id].blurb).toBe("string");
    }
  });

  test("getChannel returns the definition for a known id", () => {
    expect(getChannel("beta")).toBe(CHANNELS.beta);
  });

  test("listChannels yields all channels ascending by rank", () => {
    expect(listChannels().map((c) => c.id)).toEqual(["prod", "beta", "alpha"]);
  });
});

describe("channels — isReleaseChannel guard", () => {
  test.each(["prod", "beta", "alpha"])("accepts the known channel %s", (id) => {
    expect(isReleaseChannel(id)).toBe(true);
  });

  test.each([["stable"], ["PROD"], [""], [null], [undefined], [1], [{}]])(
    "rejects the non-channel %p",
    (value) => {
      expect(isReleaseChannel(value)).toBe(false);
    },
  );
});

describe("channels — resolveChannel", () => {
  test("returns the stored channel when it is a known id", () => {
    expect(resolveChannel({ channel: "alpha" })).toBe("alpha");
  });

  test("defaults to prod when absent", () => {
    expect(resolveChannel({})).toBe("prod");
    expect(resolveChannel(undefined)).toBe("prod");
  });

  test("defaults to prod when the stored value is not a known channel", () => {
    // A record carrying a garbage value never silently resolves to that value.
    expect(resolveChannel({ channel: "nightly" as unknown as ReleaseChannel })).toBe("prod");
  });
});

describe("channels — canPromoteChannel (direction rule)", () => {
  test("allows exactly one rung toward prod: alpha→beta and beta→prod", () => {
    expect(canPromoteChannel("alpha", "beta")).toBe(true);
    expect(canPromoteChannel("beta", "prod")).toBe(true);
  });

  test("rejects the wrong direction (away from prod)", () => {
    expect(canPromoteChannel("prod", "beta")).toBe(false);
    expect(canPromoteChannel("beta", "alpha")).toBe(false);
  });

  test("rejects skipping a rung (alpha→prod)", () => {
    expect(canPromoteChannel("alpha", "prod")).toBe(false);
  });

  test("rejects a no-op promotion onto the same channel", () => {
    for (const id of CHANNEL_IDS) expect(canPromoteChannel(id, id)).toBe(false);
  });
});
