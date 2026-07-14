import { describe, expect, test } from "bun:test"
import type {
  Process,
  ProcessStep,
  ProcessStepCategory,
} from "../store/AppContext"
import {
  enumerateStackVariants,
  stackDivergences,
  stackSubstrates,
} from "./stackDivergence"

const step = (
  id: string,
  p: Partial<ProcessStep> & { stepCategory?: ProcessStepCategory } = {},
): ProcessStep => ({
  id,
  name: id,
  stepCategory: "wet_deposition",
  color: "#000",
  ...p,
})

const param = (value: string) => ({ value, mode: "constant" as const })

const process = (stages: ProcessStep[][], p: Partial<Process> = {}): Process =>
  ({
    id: "p",
    name: "P",
    stages: stages.map((alternatives, index) => ({ index, alternatives })),
    ...p,
  }) as Process

const labels = {
  categoryLabel: (s: ProcessStep) => s.stepCategory,
  materialLabel: (s: ProcessStep) => s.inlineMaterial?.name ?? "",
}

const SUBS = [{ id: "sub", name: "ITO glass" }]

describe("enumeration order matches stack generation", () => {
  test("substrates are the outer loop, step combinations the inner", () => {
    const p = process([[step("a1"), step("a2")], [step("b1")]])
    const subs = [
      { id: "s1", name: "S1" },
      { id: "s2", name: "S2" },
    ]
    const variants = enumerateStackVariants(p, subs)
    expect(
      variants.map((v) => [
        v.combination,
        v.substrate.id,
        v.combo.map((s) => s.id).join("+"),
      ]),
    ).toEqual([
      [0, "s1", "a1+b1"],
      [1, "s1", "a2+b1"],
      [2, "s2", "a1+b1"],
      [3, "s2", "a2+b1"],
    ])
  })

  test("referenced substrates come before inline ones, danglers are skipped", () => {
    const p = process([], {
      substrateIds: ["known", "missing"],
      inlineSubstrates: [{ id: "inline", name: "Foil" }],
    } as Partial<Process>)
    const names = new Map([["known", "ITO"]])
    expect(stackSubstrates(p, (id) => names.get(id))).toEqual([
      { id: "known", name: "ITO" },
      { id: "inline", name: "Foil" },
    ])
  })
})

describe("a stage with two alternatives", () => {
  const p = process([
    [step("spin"), step("blade")],
    [step("anneal")], // common to both — explains nothing
  ])
  // Give the alternatives differing parameters.
  p.stages[0].alternatives[0].depositionMethod = param("Spin Coating")
  p.stages[0].alternatives[0].annealingTemp = param("100")
  p.stages[0].alternatives[1].depositionMethod = param("Blade Coating")
  p.stages[0].alternatives[1].annealingTemp = param("120")

  const d = stackDivergences(p, SUBS, labels)

  test("the reference stack is stack 0 and carries no diffs", () => {
    expect(d.get(0)!.isReference).toBe(true)
    expect(d.get(0)!.diffs).toEqual([])
  })

  test("the title names the diverging step and which alternative it took", () => {
    expect(d.get(1)!.title).toBe("Step #1: Alternative 2/2 — blade")
  })

  test("every differing field is listed, and only differing fields", () => {
    const diffs = d.get(1)!.diffs
    expect(diffs.map((x) => x.label)).toEqual([
      "Step #1 · Name",
      "Step #1 · Deposition Method",
      "Step #1 · Annealing Temperature",
    ])
    expect(diffs[1]).toEqual({
      label: "Step #1 · Deposition Method",
      value: "Blade Coating",
      reference: "Spin Coating",
    })
    // The unit comes along for a unit-bearing parameter.
    expect(diffs[2].value).toBe("120 °C")
    expect(diffs[2].reference).toBe("100 °C")
  })

  test("stage 2 is common to both stacks and contributes nothing", () => {
    expect(d.get(1)!.diffs.some((x) => x.label.startsWith("Step #2"))).toBe(
      false,
    )
  })
})

describe("a missing value on one side", () => {
  test("renders as an em-dash rather than an empty cell", () => {
    const p = process([[step("a"), step("b")]])
    p.stages[0].alternatives[0].annealingTemp = param("150")
    const d = stackDivergences(p, SUBS, labels)
    const temp = d
      .get(1)!
      .diffs.find((x) => x.label === "Step #1 · Annealing Temperature")!
    expect(temp.reference).toBe("150 °C")
    expect(temp.value).toBe("—")
  })
})

describe("a 'do nothing' alternative", () => {
  test("is titled as a skipped layer", () => {
    const p = process([
      [step("spin"), step("none", { stepCategory: "do_nothing" })],
    ])
    const d = stackDivergences(p, SUBS, labels)
    expect(d.get(1)!.title).toBe("Step #1: Alternative 2/2 — skipped")
    expect(
      d.get(1)!.diffs.find((x) => x.label === "Step #1 · Category")?.value,
    ).toBe("do_nothing")
  })
})

describe("divergence by substrate", () => {
  test("both the substrate and the step choice appear in the title", () => {
    const p = process([[step("a1"), step("a2")]])
    const subs = [
      { id: "s1", name: "ITO" },
      { id: "s2", name: "FTO" },
    ]
    const d = stackDivergences(p, subs, labels)
    // combination 3 = substrate FTO × alternative 2
    expect(d.get(3)!.title).toBe(
      "Substrate: FTO  ·  Step #1: Alternative 2/2 — a2",
    )
    expect(d.get(3)!.diffs[0]).toEqual({
      label: "Substrate",
      value: "FTO",
      reference: "ITO",
    })
  })
})

describe("no alternatives at all", () => {
  test("the single stack says so instead of inventing a divergence", () => {
    const p = process([[step("a")], [step("b")]])
    const d = stackDivergences(p, SUBS, labels)
    expect(d.size).toBe(1)
    expect(d.get(0)!.title).toBe("Only combination — no alternatives defined")
    expect(d.get(0)!.diffs).toEqual([])
  })
})

describe("baseline override", () => {
  test("diffs are measured against the first stack still visible", () => {
    const p = process([[step("a1"), step("a2"), step("a3")]])
    p.stages[0].alternatives[1].annealingTemp = param("120")
    p.stages[0].alternatives[2].annealingTemp = param("140")
    // Stack 0 deleted → stack 1 becomes the reference.
    const d = stackDivergences(p, SUBS, labels, 1)
    expect(d.get(1)!.isReference).toBe(true)
    const temp = d
      .get(2)!
      .diffs.find((x) => x.label === "Step #1 · Annealing Temperature")!
    expect(temp.reference).toBe("120 °C")
    expect(temp.value).toBe("140 °C")
  })
})
