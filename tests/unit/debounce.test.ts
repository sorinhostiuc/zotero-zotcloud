import { describe, it, expect, vi } from "vitest";
import { debounce } from "../../src/modules/utils/debounce";

describe("debounce", () => {
  it("delays function execution", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 70));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on subsequent calls", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    await new Promise((r) => setTimeout(r, 30));
    debounced(); // Reset timer

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled(); // Still waiting

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes arguments to the debounced function", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("hello", 42);

    await new Promise((r) => setTimeout(r, 70));
    expect(fn).toHaveBeenCalledWith("hello", 42);
  });
});
