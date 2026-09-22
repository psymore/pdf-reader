import { describe, it, expect, vi } from "vitest";
import { emit, on } from "../src/app-events.js";

describe("app-events", () => {
  it("calls a registered handler with the emitted detail", () => {
    const handler = vi.fn();
    on("test-event", handler);
    emit("test-event", { foo: "bar" });
    expect(handler).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("does not call handlers registered for a different event name", () => {
    const handler = vi.fn();
    on("other-event", handler);
    emit("test-event-2", { foo: "bar" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    on("multi-event", handlerA);
    on("multi-event", handlerB);
    emit("multi-event", 42);
    expect(handlerA).toHaveBeenCalledWith(42);
    expect(handlerB).toHaveBeenCalledWith(42);
  });
});
