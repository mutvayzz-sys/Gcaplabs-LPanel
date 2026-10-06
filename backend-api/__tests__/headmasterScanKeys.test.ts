const { scanKeys } = require("../headmasterLaunch");

describe("headmasterLaunch scanKeys", () => {
  it("walks every SCAN page with MATCH and never calls KEYS", async () => {
    const pages = { "0": ["7", ["hm:sess:a", "hm:sess:b"]], "7": ["0", ["hm:sess:b", "hm:sess:c"]] };
    const redis = {
      scan: jest.fn(async (cursor) => pages[cursor]),
      keys: jest.fn(() => { throw new Error("KEYS must not be used"); }),
    };
    const keys = await scanKeys(redis, "hm:sess:*");
    expect(keys.sort()).toEqual(["hm:sess:a", "hm:sess:b", "hm:sess:c"]);
    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.scan).toHaveBeenCalledWith("0", "MATCH", "hm:sess:*", "COUNT", 200);
    expect(redis.keys).not.toHaveBeenCalled();
  });
});
