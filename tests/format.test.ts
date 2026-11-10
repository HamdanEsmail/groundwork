// Dates are UTC and never shifted. Cuts and money follow the site's voice.
import { describe, expect, it } from "vitest";
import { day, int, sentence, stamp, usd, words } from "../src/site/format";

describe("day", () => {
  it("writes a calendar day as D Mon YYYY in UTC", () => {
    expect(day("1993-09-17")).toBe("17 Sep 1993");
    expect(day("2026-11-09T17:34:00.000Z")).toBe("9 Nov 2026");
  });

  it("does not shift a UTC morning into the previous local day", () => {
    expect(day("2026-11-09T00:30:00.000Z")).toBe("9 Nov 2026");
  });

  it("prints not stated when the date is missing or unreadable", () => {
    expect(day(null)).toBe("not stated");
    expect(day(undefined)).toBe("not stated");
    expect(day("")).toBe("not stated");
    expect(day("the fifth")).toBe("not stated");
  });
});

describe("stamp", () => {
  it("writes a read time as D Mon YYYY, HH:MM UTC", () => {
    expect(stamp("2026-11-09T17:34:00.000Z")).toBe("9 Nov 2026, 17:34 UTC");
  });

  it("prints not stated when the time is missing", () => {
    expect(stamp(null)).toBe("not stated");
  });
});

describe("int", () => {
  it("groups thousands", () => {
    expect(int(723780)).toBe("723,780");
    expect(int(4)).toBe("4");
  });

  it("prints not stated when the number is missing", () => {
    expect(int(null)).toBe("not stated");
  });
});

describe("usd", () => {
  it("writes whole dollars with a grouping comma", () => {
    expect(usd(148232900)).toBe("$148,232,900");
  });

  it("keeps mills on a TinyFish spend figure", () => {
    expect(usd(0.008)).toBe("$0.008");
  });

  it("prints not stated when the amount is missing", () => {
    expect(usd(null)).toBe("not stated");
  });
});

describe("words", () => {
  it("cuts at a word on the 150-character bound", () => {
    const text = "Permit for the erection of a non-accessory outdoor advertising sign above the bottom of the 2nd. floor of an existing building and then a great deal more text that should not appear in the cut.";
    const cut = words(text, 150);
    expect(cut.length).toBeLessThanOrEqual(150);
    expect(cut.endsWith(" ")).toBe(false);
    expect(text.startsWith(cut)).toBe(true);
    expect(cut.includes("should not appear")).toBe(false);
  });

  it("leaves a short string alone", () => {
    expect(words("Open")).toBe("Open");
  });
});

describe("sentence", () => {
  it("uppercases the first letter and lowers the rest", () => {
    expect(sentence("OPEN")).toBe("Open");
    expect(sentence("CONTINUATION")).toBe("Continuation");
    expect(sentence("issued")).toBe("Issued");
  });
});
