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

describe("DockerBackend.setBotScreenGate", () => {
  function make(exitCode = 0) {
    const { EventEmitter } = require("events");
    const stream = new EventEmitter();
    const inspect = jest.fn().mockResolvedValue({ ExitCode: exitCode });
    const start = jest.fn().mockImplementation(async () => {
      setImmediate(() => stream.emit("end"));
      return stream;
    });
    const exec = jest.fn().mockResolvedValue({ start, inspect });
    const backend = new DockerBackend();
    backend.docker = { getContainer: jest.fn().mockReturnValue({ exec }) };
    return { backend, exec };
  }

  it("creates the root-owned gate file as root", async () => {
    const { backend, exec } = make();
    await expect(backend.setBotScreenGate("cid", true)).resolves.toEqual({ bot_screen: true });
    const opts = exec.mock.calls[0][0];
    expect(opts.User).toBe("root");
    expect(opts.Cmd[2]).toContain("mkdir -p /etc/headmaster");
    expect(opts.Cmd[2]).toContain("chmod 0755 /etc/headmaster");
    expect(opts.Cmd[2]).toContain("chmod 0644 /etc/headmaster/bot-screen.enabled");
    expect(opts.Cmd[2]).toContain("chown root:root /etc/headmaster/bot-screen.enabled");
  });

  it("removes the gate file as root", async () => {
    const { backend, exec } = make();
    await backend.setBotScreenGate("cid", false);
    expect(exec.mock.calls[0][0].User).toBe("root");
    expect(exec.mock.calls[0][0].Cmd[2]).toBe("rm -f /etc/headmaster/bot-screen.enabled");
  });

  it("fails on a non-zero exit and on a non-boolean", async () => {
    await expect(make(1).backend.setBotScreenGate("cid", true)).rejects.toThrow(/exit 1/);
    const { backend, exec } = make();
    await expect(backend.setBotScreenGate("cid", "true")).rejects.toThrow(/Invalid/);
    expect(exec).not.toHaveBeenCalled();
  });
});
