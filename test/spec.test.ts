import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasBlockedPending,
  nextPending,
  parseSpec,
  readSpec,
  resetFrom,
  resetStale,
  setStatus,
  summarize,
  validateSpec,
} from "../src/spec.js";

const FIXTURE = `# Backlog

## feature: Add two numbers
id: F001
status: PENDING
depends: none
acceptance:
  - add(2,3) returns 5

## feature: Subtract two numbers
id: F002
status: PENDING
depends: F001
test: npm test -- sub
acceptance:
  - sub(5,3) returns 2
  - negative results work
notes: |
  Lives in src/math.ts

## feature: Multiply
id: F003
status: PENDING
depends: F002
acceptance:
  - mul(2,3) returns 6
`;

let dir: string;
let specPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-test-"));
  specPath = join(dir, "PROJECT_SPEC.md");
  writeFileSync(specPath, FIXTURE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parsing", () => {
  it("reads every feature block", () => {
    const features = parseSpec(FIXTURE);
    expect(features).toHaveLength(3);
    expect(features[0]?.name).toBe("Add two numbers");
    expect(features[1]?.id).toBe("F002");
    expect(features[2]?.index).toBe(3);
  });

  it("reads optional per-feature fields", () => {
    const f = parseSpec(FIXTURE)[1];
    expect(f?.test).toBe("npm test -- sub");
    expect(f?.depends).toEqual(["F001"]);
    expect(f?.acceptance).toHaveLength(2);
    expect(f?.notes).toContain("src/math.ts");
  });

  it("treats 'none' as no dependencies", () => {
    expect(parseSpec(FIXTURE)[0]?.depends).toEqual([]);
  });

  describe("tolerates the decoration models actually emit", () => {
    // A real bootstrap failure: the model wrote `depends: [F001]` three times
    // in a row. It is valid YAML and unambiguous; rejecting it wasted every
    // retry on punctuation.
    const withVariants = `## feature: One
id: "F001"
status: PENDING
depends: none
acceptance:
  - a

## feature: Two
id: F002
status: pending
depends: [F001]
acceptance:
  - b

## feature: Three
id: \`F003\`
status: PENDING
depends: [F001, F002]
acceptance:
  - c
`;
    it("accepts bracketed dependency lists", () => {
      const f = parseSpec(withVariants);
      expect(f[1]?.depends).toEqual(["F001"]);
      expect(f[2]?.depends).toEqual(["F001", "F002"]);
    });

    it("strips quotes and backticks from ids", () => {
      const f = parseSpec(withVariants);
      expect(f[0]?.id).toBe("F001");
      expect(f[2]?.id).toBe("F003");
    });

    it("accepts a lowercase status", () => {
      expect(parseSpec(withVariants)[1]?.status).toBe("PENDING");
    });

    it("validates clean, so no retry is wasted on syntax", () => {
      expect(validateSpec(withVariants)).toEqual([]);
    });

    it("still treats an empty bracketed list as no dependencies", () => {
      const f = parseSpec(`## feature: X
id: F001
status: PENDING
depends: []
acceptance:
  - a
`);
      expect(f[0]?.depends).toEqual([]);
    });
  });

  it("keeps the raw block for the model prompt", () => {
    const raw = parseSpec(FIXTURE)[0]?.raw ?? "";
    expect(raw).toContain("## feature: Add two numbers");
    expect(raw).not.toContain("Subtract");
  });
});

describe("validation", () => {
  it("accepts a well-formed spec", () => {
    expect(validateSpec(FIXTURE)).toEqual([]);
  });

  it("reports missing and invalid fields in model-readable language", () => {
    const errors = validateSpec(`## feature: No status
id: F001
acceptance:
  - something

## feature: Duplicate id
id: F001
status: WEIRD
`);
    expect(errors.join("\n")).toMatch(/missing "status:"/);
    expect(errors.join("\n")).toMatch(/invalid status "WEIRD"/);
    expect(errors.join("\n")).toMatch(/duplicate id "F001"/);
    expect(errors.join("\n")).toMatch(/missing the "acceptance:" list/);
  });

  it("rejects an empty spec", () => {
    expect(validateSpec("# nothing here")[0]).toMatch(/No features found/);
  });

  it("catches a dependency defined later, which can never be satisfied", () => {
    const errors = validateSpec(`## feature: First
id: F001
status: PENDING
depends: F002
acceptance:
  - x

## feature: Second
id: F002
status: PENDING
acceptance:
  - y
`);
    expect(errors.join("\n")).toMatch(/defined later/);
  });

  it("catches a dependency on an unknown id", () => {
    const errors = validateSpec(`## feature: Only
id: F001
status: PENDING
depends: F099
acceptance:
  - x
`);
    expect(errors.join("\n")).toMatch(/unknown id "F099"/);
  });
});

describe("status transitions", () => {
  it("writes a status and leaves neighbours untouched", () => {
    setStatus(specPath, 1, "COMPLETED");
    const features = readSpec(specPath);
    expect(features[0]?.status).toBe("COMPLETED");
    expect(features[1]?.status).toBe("PENDING");
    expect(features[2]?.status).toBe("PENDING");
  });

  it("does not corrupt the rest of the file", () => {
    setStatus(specPath, 2, "FAILED");
    const text = readFileSync(specPath, "utf8");
    expect(text).toContain("test: npm test -- sub");
    expect(text).toContain("Lives in src/math.ts");
    expect(text.match(/^#*\s*feature:/gim)).toHaveLength(3);
  });

  it("returns failed features to PENDING", () => {
    setStatus(specPath, 1, "FAILED");
    setStatus(specPath, 3, "FAILED");
    expect(resetFrom(specPath, "FAILED")).toBe(2);
    expect(readSpec(specPath).every((f) => f.status === "PENDING")).toBe(true);
  });

  it("unsticks features left IN_PROGRESS by a dead run", () => {
    setStatus(specPath, 2, "IN_PROGRESS");
    const seen: number[] = [];
    expect(resetStale(specPath, (f) => seen.push(f.index))).toBe(1);
    expect(seen).toEqual([2]);
    expect(readSpec(specPath)[1]?.status).toBe("PENDING");
  });
});

describe("scheduling", () => {
  it("picks the first pending feature", () => {
    expect(nextPending(readSpec(specPath))?.index).toBe(1);
  });

  it("skips features whose dependencies are unmet", () => {
    setStatus(specPath, 1, "FAILED");
    expect(nextPending(readSpec(specPath))).toBeUndefined();
    expect(hasBlockedPending(readSpec(specPath))).toBe(true);
  });

  it("treats UNVERIFIED as satisfying a dependency", () => {
    setStatus(specPath, 1, "UNVERIFIED");
    expect(nextPending(readSpec(specPath))?.index).toBe(2);
  });

  it("reports no blocked pending when the backlog is simply done", () => {
    for (const i of [1, 2, 3]) setStatus(specPath, i, "COMPLETED");
    const features = readSpec(specPath);
    expect(nextPending(features)).toBeUndefined();
    expect(hasBlockedPending(features)).toBe(false);
  });

  it("summarises counts", () => {
    setStatus(specPath, 1, "COMPLETED");
    setStatus(specPath, 2, "FAILED");
    const s = summarize(readSpec(specPath));
    expect(s).toMatchObject({ total: 3, completed: 1, failed: 1, pending: 1 });
  });
});
