// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockDecrypt = jest.fn();
jest.mock("../db", () => mockDb);
jest.mock("pg", () => ({ Client: jest.fn() }));
jest.mock("../crypto", () => ({
  encrypt: (value) => `encrypted:${value}`,
  decrypt: mockDecrypt,
  ensureEncryptionConfigured: jest.fn(),
}));

const { resolveInferenceProvider } = require("../llmProviders");

beforeEach(() => {
  mockDb.query.mockReset();
  mockDecrypt.mockReset().mockReturnValue("decrypted-provider-key");
});

test("resolves one trusted provider row, decrypts only its key and preserves endpoint metadata", async () => {
  mockDb.query
    .mockResolvedValueOnce({
      rows: [
        {
          id: "provider-row-id",
          provider: "openai",
          model: "gpt-5.5",
          config: { base_url: "https://api.openai.com/v1", api_version: "v1" },
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [{ api_key: "ciphertext-only" }] });

  const resolved = await resolveInferenceProvider("nora-owner-id", "provider-row-id", mockDb);

  expect(mockDb.query).toHaveBeenCalledTimes(2);
  expect(mockDb.query.mock.calls[0][1]).toEqual(["nora-owner-id", "provider-row-id"]);
  expect(mockDb.query.mock.calls[1][1]).toEqual(["nora-owner-id", "provider-row-id"]);
  expect(mockDecrypt).toHaveBeenCalledWith("ciphertext-only");
  expect(resolved).toEqual(
    expect.objectContaining({
      id: "provider-row-id",
      provider: "openai",
      model: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.5-pro"],
      apiKey: "decrypted-provider-key",
      baseUrl: "https://api.openai.com/v1",
      apiVersion: "v1",
    }),
  );
});

test("fails closed when the selected owned provider row has no credential", async () => {
  mockDb.query
    .mockResolvedValueOnce({
      rows: [{ id: "provider-row-id", provider: "openai", model: "gpt-5.5", config: {} }],
    })
    .mockResolvedValueOnce({ rows: [] });

  await expect(
    resolveInferenceProvider("nora-owner-id", "provider-row-id", mockDb),
  ).rejects.toMatchObject({ code: "INFERENCE_PROVIDER_CREDENTIAL_UNAVAILABLE" });
  expect(mockDecrypt).not.toHaveBeenCalled();
});
