import {
  fingerprintExternalAgentIdentity,
  normalizeExternalAgentIdentity,
  stableJson,
} from "../externalAgentIdentity";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_OWNER_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const principal = { ownerUuid: OWNER_UUID };

const request = {
  user_id: USER_ID,
  namespace: "headmaster",
  external_id: WORKSPACE_ID,
  owner_uuid: OWNER_UUID,
  runtime_family: "hermes",
  runtime_target: "docker",
};

describe("external agent identity normalization", () => {
  it("accepts a canonical workspace UUID and takes owner identity from the principal", () => {
    expect(normalizeExternalAgentIdentity(request, principal)).toEqual({
      user_id: USER_ID,
      namespace: "headmaster",
      external_id: WORKSPACE_ID,
      owner_uuid: OWNER_UUID,
      runtime_family: "hermes",
      runtime_target: "docker",
    });
  });

  it("rejects a missing namespace", () => {
    expect(() =>
      normalizeExternalAgentIdentity({ ...request, namespace: undefined }, principal),
    ).toThrow(/namespace/i);
  });

  it("rejects an oversized namespace", () => {
    expect(() =>
      normalizeExternalAgentIdentity({ ...request, namespace: "n".repeat(512) }, principal),
    ).toThrow(/namespace/i);
  });

  it("rejects a namespace other than headmaster", () => {
    expect(() => normalizeExternalAgentIdentity({ ...request, namespace: "other" }, principal)).toThrow(
      /namespace/i,
    );
  });

  it("rejects malformed and non-canonical workspace UUIDs", () => {
    expect(() =>
      normalizeExternalAgentIdentity({ ...request, external_id: "not-a-uuid" }, principal),
    ).toThrow(/external.*uuid/i);
    expect(() =>
      normalizeExternalAgentIdentity(
        { ...request, external_id: "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase() },
        principal,
      ),
    ).toThrow(/external.*uuid/i);
  });

  it("rejects a caller-supplied owner UUID that differs from the authenticated principal", () => {
    expect(() =>
      normalizeExternalAgentIdentity({ ...request, owner_uuid: OTHER_OWNER_UUID }, principal),
    ).toThrow(/owner/i);
  });

  it("returns a frozen identity without mutable presentation fields", () => {
    const identity = normalizeExternalAgentIdentity(
      { ...request, name: "Before rename", email: "before@example.test" },
      principal,
    );

    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity).not.toHaveProperty("name");
    expect(identity).not.toHaveProperty("email");
  });
});

describe("external agent request fingerprint", () => {
  it("sorts object keys recursively in stable JSON", () => {
    expect(stableJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(stableJson({ a: { x: 3, y: 2 }, z: 1 })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("preserves array order while canonicalizing objects inside arrays", () => {
    expect(stableJson([{ z: 1, a: 2 }, "second"])).toBe('[{"a":2,"z":1},"second"]');
    expect(stableJson(["second", { a: 2, z: 1 }])).not.toBe(
      stableJson([{ z: 1, a: 2 }, "second"]),
    );
  });

  it("computes the SHA-256 fingerprint from the canonical immutable fields", () => {
    const identity = normalizeExternalAgentIdentity(request, principal);

    expect(fingerprintExternalAgentIdentity(identity)).toBe(
      "71e00bf726bff34446480b259ab145f92a4e4bba5acdab7f3a3f5e475c4696a5",
    );
  });

  it("ignores name, email, mutable sizing, and credential material", () => {
    const identity = normalizeExternalAgentIdentity(request, principal);
    const withMutableFields = {
      ...identity,
      name: "Renamed agent",
      email: "renamed@example.test",
      resources: { cpu: 16, memory: "32Gi" },
      credentials: { apiKey: "must-not-be-hashed" },
    };

    expect(fingerprintExternalAgentIdentity(withMutableFields)).toBe(
      fingerprintExternalAgentIdentity(identity),
    );
  });

  it("keeps the immutable identity and fingerprint unchanged when the agent is renamed", () => {
    const beforeRename = normalizeExternalAgentIdentity(
      { ...request, name: "Original name", email: "original@example.test" },
      principal,
    );
    const afterRename = normalizeExternalAgentIdentity(
      { ...request, name: "New name", email: "new@example.test" },
      principal,
    );

    expect(afterRename).toEqual(beforeRename);
    expect(fingerprintExternalAgentIdentity(afterRename)).toBe(
      fingerprintExternalAgentIdentity(beforeRename),
    );
  });
});
