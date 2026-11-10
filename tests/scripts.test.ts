import { describe, expect, it } from "vitest";
import markdown from "../docs/demo-addresses.md?raw";
import { hasMonitorCapacity, parseDemoAddresses } from "../scripts/demo-addresses.mjs";

describe("demo address table", () => {
  it("reads the addresses and optional OPA", () => {
    expect(parseDemoAddresses(markdown)).toEqual([
      { address: "1234 Market St", opa: "883309050" },
      { address: "5600 Germantown Ave", opa: null },
      { address: "4001 Walnut St", opa: null },
    ]);
  });
  it("rejects missing, duplicate, and incomplete address tables", () => {
    expect(() => parseDemoAddresses("missing")).toThrow();
    expect(() => parseDemoAddresses(markdown.replace("5600 Germantown Ave", "4001 Walnut St"))).toThrow();
    expect(() => parseDemoAddresses(markdown.replace("| 3 | 4001 Walnut St", "| x | 4001 Walnut St"))).toThrow();
  });
  it("requires room for two monitors per address", () => {
    expect(hasMonitorCapacity(4, 3)).toBe(true);
    expect(hasMonitorCapacity(5, 3)).toBe(false);
    expect(hasMonitorCapacity(-1, 3)).toBe(false);
    expect(hasMonitorCapacity(NaN, 3)).toBe(false);
  });
});
