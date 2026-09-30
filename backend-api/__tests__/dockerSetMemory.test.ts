const DockerBackend = require("../../workers/provisioner/backends/docker");

describe("DockerBackend.setMemory", () => {
  function make() {
    const update = jest.fn().mockResolvedValue({});
    const backend = new DockerBackend();
    backend.docker = { getContainer: jest.fn().mockReturnValue({ update }) };
    return { backend, update };
  }

  it("updates the live cgroup limit with swap pinned to it", async () => {
    const { backend, update } = make();
    const out = await backend.setMemory("cid", 3072);
    expect(update).toHaveBeenCalledWith({ Memory: 3072 * 1048576, MemorySwap: 3072 * 1048576 });
    expect(out).toEqual({ ram_mb: 3072 });
  });

  it.each([0, 100, "abc", 1.5, null])("rejects %p", async (v) => {
    const { backend, update } = make();
    await expect(backend.setMemory("cid", v)).rejects.toThrow(/Invalid memory limit/);
    expect(update).not.toHaveBeenCalled();
  });
});
