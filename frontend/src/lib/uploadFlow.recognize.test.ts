import { describe, expect, test } from "bun:test"
import {
  recognizeGroupName,
  recognizeGroupNames,
  stripPixelSuffix,
} from "./uploadFlow"

// Two real exports of the same CHOSE instrument suite. "batch" uses the lab's
// terse "AI44"-style substrate ids; "batch2" uses compound ids the old
// letter+digit recognizer could not see, collapsing a whole upload to the one
// stray "JV Summary" file. See docs/plans/batch2-grouping-and-uvvis.md.

describe("recognizeGroupName — terse AI## ids (batch)", () => {
  test("stability run, per-pixel file → substrate without the pixel", () => {
    expect(
      recognizeGroupName("0001_2025-11-20_17.21.53_Stability (JV)_AI12-1A.txt"),
    ).toBe("AI12")
  })

  test("substrate-level IPCE (no pixel) → the substrate", () => {
    expect(recognizeGroupName("2025-11-20_16.03.54_IPCE_AI12.txt")).toBe("AI12")
  })

  test("Dark JV marker", () => {
    expect(recognizeGroupName("2025-11-20_14.19.16_Dark JV_AI12.txt")).toBe(
      "AI12",
    )
  })

  test("tracking / parameters halves land on the same substrate", () => {
    expect(
      recognizeGroupName(
        "0000_2025-11-20_17.21.53_Stability (Tracking)_AI21-1B.txt",
      ),
    ).toBe("AI21")
    expect(
      recognizeGroupName(
        "0000_2025-11-20_17.21.53_Stability (Parameters)_AI21-1B.txt",
      ),
    ).toBe("AI21")
  })

  test("a hand-named file with only the id still resolves (no marker)", () => {
    expect(recognizeGroupName("AI44-1C.txt")).toBe("AI44")
  })
})

describe("recognizeGroupName — compound ids (batch2)", () => {
  test("the compound device id survives, minus the pixel", () => {
    expect(
      recognizeGroupName(
        "0001_2026-04-09_17.54.13_Stability (JV)_B37_Ref_100uL_S3-1C.txt",
      ),
    ).toBe("B37_Ref_100uL_S3")
  })

  test("the 'I' variant is NOT confused with its base", () => {
    expect(
      recognizeGroupName(
        "0000_2026-04-09_18.08.30_Stability (Tracking)_B37_Bic_150uL_S12I-1A.txt",
      ),
    ).toBe("B37_Bic_150uL_S12I")
    expect(
      recognizeGroupName(
        "0000_2026-04-09_18.06.38_Stability (Tracking)_B37_Bic_150uL_S12-1A.txt",
      ),
    ).toBe("B37_Bic_150uL_S12")
  })

  test("original mixed case is preserved for readability", () => {
    expect(
      recognizeGroupName(
        "0001_2026-04-09_18.00.00_Stability (JV)_B37_Ser_150uL_S31-1D.txt",
      ),
    ).toBe("B37_Ser_150uL_S31")
  })
})

describe("recognizeGroupName — aggregates and non-devices seed nothing", () => {
  test("JV Summary is not a substrate", () => {
    expect(recognizeGroupName("JV Summary.txt")).toBeNull()
  })

  test("JV Summary_Parameters (underscore defeats a word boundary) too", () => {
    expect(recognizeGroupName("JV Summary_Parameters FW.txt")).toBeNull()
    expect(recognizeGroupName("JV Summary_Parameters RV.txt")).toBeNull()
  })

  test("a UV-Vis film name does not seed a stray single-letter 'T'", () => {
    expect(recognizeGroupName("T-PVK 1.68 V_1.6 M_AS 100 uL.txt")).toBeNull()
  })

  test("a pure date/sequence name yields nothing", () => {
    expect(recognizeGroupName("2026-04-09.txt")).toBeNull()
  })
})

describe("recognizeGroupNames — deduplicated set over a whole upload", () => {
  test("batch2 yields the compound substrates, no JV/T noise", () => {
    const files = [
      "0001_2026-04-09_17.54.13_Stability (JV)_B37_Ref_100uL_S3-1C.txt",
      "0002_2026-04-09_17.54.13_Stability (JV)_B37_Ref_100uL_S3-1C.txt",
      "0000_2026-04-09_17.54.13_Stability (Tracking)_B37_Ref_100uL_S3-1D.txt",
      "0000_2026-04-09_18.08.30_Stability (JV)_B37_Bic_150uL_S12I-1A.txt",
      "0000_2026-04-09_18.06.38_Stability (JV)_B37_Bic_150uL_S12-1A.txt",
      "JV Summary.txt",
      "JV Summary_Parameters FW.txt",
      "T-PVK 1.68 V_1.6 M_AS 100 uL.txt",
    ]
    expect(recognizeGroupNames(files)).toEqual([
      "B37_Ref_100uL_S3",
      "B37_Bic_150uL_S12I",
      "B37_Bic_150uL_S12",
    ])
  })

  test("batch still yields the AI## substrates", () => {
    const files = [
      "0001_2025-11-20_17.21.53_Stability (JV)_AI12-1A.txt",
      "2025-11-20_16.03.54_IPCE_AI12.txt",
      "0001_2025-11-20_17.21.53_Stability (JV)_AI19-1A.txt",
    ]
    expect(recognizeGroupNames(files)).toEqual(["AI12", "AI19"])
  })
})

describe("stripPixelSuffix", () => {
  test("strips the trailing cell+pixel", () => {
    expect(stripPixelSuffix("AI12-1A")).toBe("AI12")
    expect(stripPixelSuffix("B37_Ref_100uL_S3-1C")).toBe("B37_Ref_100uL_S3")
  })

  test("leaves a device with no pixel untouched", () => {
    expect(stripPixelSuffix("AI12")).toBe("AI12")
    expect(stripPixelSuffix("B37_Ref_150uL_11LS2")).toBe("B37_Ref_150uL_11LS2")
  })
})
