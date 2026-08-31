import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  it("keeps only the last N items", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);

    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.last).toBe(4);
  });

  it("replaces contents from an array", () => {
    const buffer = new RingBuffer<string>(2);
    buffer.replace(["a", "b", "c", "d"]);

    expect(buffer.toArray()).toEqual(["c", "d"]);
  });
});
