import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  MultiSelect,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
} from "@mantine/core"
import {
  IconChartBar,
  IconGripVertical,
  IconPlus,
  IconX,
} from "@tabler/icons-react"
import EChartsReact from "echarts-for-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Experiment } from "../store/AppContext"
import { useAppContext } from "../store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DataSourceMode =
  | "all-devices"
  | "per-device"
  | "per-substrate"
  | "per-varied-parameter"

type PlotWidget = {
  id: string
  type: "boxplot" | "jv-curve" | "scatter" | "bar"
  title: string
  x: number
  y: number
  width: number
  height: number
  experimentId?: string
  layerIds?: string[]
  parameterKey?: string
}

type DragState = {
  widgetId: string
  startX: number
  startY: number
  startWidgetX: number
  startWidgetY: number
} | null

type ResizeState = {
  widgetId: string
  startX: number
  startY: number
  startWidth: number
  startHeight: number
} | null

// ─────────────────────────────────────────────────────────────────────────────
// Plot Colors
// ─────────────────────────────────────────────────────────────────────────────

const PLOT_COLORS = {
  primary: "#228be6",
  secondary: "#fa5252",
  tertiary: "#40c057",
  quaternary: "#fab005",
  quinary: "#7950f2",
  senary: "#e64980",
}

const COLOR_ARRAY = Object.values(PLOT_COLORS)

// ─────────────────────────────────────────────────────────────────────────────
// Example Plot Data Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Generate example box plot data for PCE by layer parameter */
function generateBoxPlotOption(paramName: string) {
  const categories = ["100°C", "120°C", "140°C", "160°C"]

  const data: number[][] = categories.map((_, idx) => {
    const baseValue = 15 + idx * 1.5
    return Array.from(
      { length: 20 },
      () => baseValue + (Math.random() - 0.5) * 4,
    )
  })

  return {
    title: {
      text: `PCE vs ${paramName}`,
      left: "center",
      textStyle: { fontSize: 14 },
    },
    tooltip: {
      trigger: "item",
      borderColor: "#ccc",
      backgroundColor: "rgba(255,255,255,0.9)",
      textStyle: { color: "#333" },
    },
    grid: {
      left: 50,
      right: 20,
      bottom: 50,
      top: 60,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: categories,
      name: paramName,
    },
    yAxis: {
      type: "value",
      name: "PCE (%)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
    },
    series: data.map((values, idx) => ({
      name: categories[idx],
      type: "boxplot",
      data: [values],
      itemStyle: {
        color: COLOR_ARRAY[idx % COLOR_ARRAY.length],
      },
    })),
  }
}

/** Generate example JV curve data */
function generateJVCurveOption() {
  const generateJVCurve = (
    voc: number,
    jsc: number,
    name: string,
    color: string,
  ) => {
    const voltages: number[] = []
    const currents: number[] = []

    for (let v = -0.1; v <= voc + 0.1; v += 0.01) {
      voltages.push(parseFloat(v.toFixed(2)))
      // Simplified diode equation
      const j0 = 1e-10
      const n = 1.5
      const vt = 0.026 // thermal voltage at 300K
      const current = jsc - j0 * (Math.exp(v / (n * vt)) - 1)
      currents.push(
        parseFloat(Math.max(-5, Math.min(current, jsc * 1.1)).toFixed(2)),
      )
    }

    return {
      name,
      type: "line",
      data: voltages.map((v, i) => [v, currents[i]]),
      stroke: { width: 2 },
      smooth: true,
      itemStyle: { color },
      lineStyle: { color },
      symbol: "none",
    }
  }

  return {
    title: {
      text: "J-V Characteristics",
      left: "center",
      textStyle: { fontSize: 14 },
    },
    tooltip: {
      trigger: "axis",
      borderColor: "#ccc",
      backgroundColor: "rgba(255,255,255,0.9)",
      textStyle: { color: "#333" },
    },
    legend: {
      top: "bottom",
      data: [
        "Device A (PCE: 18.9%)",
        "Device B (PCE: 16.9%)",
        "Device C (PCE: 15.6%)",
      ],
    },
    grid: {
      left: 60,
      right: 20,
      bottom: 80,
      top: 60,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: "Voltage (V)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
      axisLine: { onZero: true, lineStyle: { color: "#868e96" } },
    },
    yAxis: {
      type: "value",
      name: "Current Density (mA/cm²)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
      axisLine: { onZero: true, lineStyle: { color: "#868e96" } },
    },
    series: [
      generateJVCurve(1.1, 22, "Device A (PCE: 18.9%)", PLOT_COLORS.primary),
      generateJVCurve(
        1.05,
        21.5,
        "Device B (PCE: 16.9%)",
        PLOT_COLORS.secondary,
      ),
      generateJVCurve(1.08, 20, "Device C (PCE: 15.6%)", PLOT_COLORS.tertiary),
    ] as any,
  }
}

/** Generate example scatter plot for parameter correlation */
function generateScatterPlotOption() {
  const n = 30
  const x = Array.from({ length: n }, () => 100 + Math.random() * 60)
  const data = x.map((xi) => [
    xi,
    12 + (xi - 100) * 0.08 + (Math.random() - 0.5) * 3,
  ])

  return {
    title: {
      text: "Annealing Temp vs PCE",
      left: "center",
      textStyle: { fontSize: 14 },
    },
    tooltip: {
      trigger: "item",
      borderColor: "#ccc",
      backgroundColor: "rgba(255,255,255,0.9)",
      textStyle: { color: "#333" },
    },
    visualMap: {
      min: Math.min(...data.map((d) => d[1])),
      max: Math.max(...data.map((d) => d[1])),
      splitNumber: 5,
      inRange: {
        color: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"],
      },
      textStyle: { color: "#333" },
    },
    grid: {
      left: 50,
      right: 60,
      bottom: 50,
      top: 60,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: "Annealing Temperature (°C)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
    },
    yAxis: {
      type: "value",
      name: "PCE (%)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
    },
    series: [
      {
        type: "scatter",
        data,
        symbolSize: 10,
        itemStyle: {
          opacity: 0.8,
        },
      },
    ],
  }
}

/** Generate example bar chart for layer comparison */
function generateBarChartOption() {
  const layers = ["ETL", "Perovskite", "HTL", "Metal"]
  const pceContribution = [2.1, 12.5, 3.2, 0.8]

  return {
    title: {
      text: "Layer Contribution to PCE",
      left: "center",
      textStyle: { fontSize: 14 },
    },
    tooltip: {
      trigger: "axis",
      borderColor: "#ccc",
      backgroundColor: "rgba(255,255,255,0.9)",
      textStyle: { color: "#333" },
    },
    grid: {
      left: 50,
      right: 20,
      bottom: 50,
      top: 60,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: layers,
      name: "Layer",
    },
    yAxis: {
      type: "value",
      name: "PCE Contribution (%)",
      splitLine: { lineStyle: { color: "#e9ecef" } },
    },
    series: [
      {
        type: "bar",
        data: pceContribution.map((value, idx) => ({
          value,
          itemStyle: {
            color: COLOR_ARRAY[idx % COLOR_ARRAY.length],
          },
        })),
      },
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment List Item
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentListItem({
  experiment,
  isSelected,
  onSelect,
}: {
  experiment: Experiment
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--mantine-color-blue-0)" : undefined,
        borderColor: isSelected ? "var(--mantine-color-blue-4)" : undefined,
      }}
      onClick={onSelect}
    >
      <Group justify="space-between" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" mb={4}>
            <Text size="sm" fw={600} truncate>
              {experiment.name || "Untitled"}
            </Text>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {experiment.date || "No date"}
            </Text>
            <Text size="xs" c="dimmed">
              •
            </Text>
            <Text size="xs" c="dimmed">
              {experiment.substrates.length} substrate
              {experiment.substrates.length !== 1 ? "s" : ""}
            </Text>
          </Group>
        </Box>
      </Group>
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Source Configuration Panel
// ─────────────────────────────────────────────────────────────────────────────

function DataSourceConfigPanel({
  mode,
  onModeChange,
  experiment,
  excludedDevices,
  onExcludedDevicesChange,
  excludedSubstrates,
  onExcludedSubstratesChange,
}: {
  mode: DataSourceMode
  onModeChange: (mode: DataSourceMode) => void
  experiment: Experiment | null
  excludedDevices: string[]
  onExcludedDevicesChange: (devices: string[]) => void
  excludedSubstrates: string[]
  onExcludedSubstratesChange: (substrates: string[]) => void
}) {
  if (!experiment) {
    return (
      <Paper
        withBorder
        p="sm"
        style={{ background: "var(--mantine-color-gray-0)" }}
      >
        <Text size="xs" c="dimmed" ta="center">
          Select an experiment to configure data sources
        </Text>
      </Paper>
    )
  }

  // Calculate device options
  const deviceOptions = Array.from(
    { length: experiment.devicesPerSubstrate * experiment.numSubstrates },
    (_, i) => ({
      value: `device-${i}`,
      label: `Device ${i + 1}`,
    }),
  )

  // Calculate substrate options
  const substrateOptions = experiment.substrates.map((sub) => ({
    value: sub.id,
    label: sub.name,
  }))

  return (
    <Paper
      withBorder
      p="sm"
      style={{ background: "var(--mantine-color-gray-0)" }}
    >
      <Stack gap="xs">
        <div>
          <Text size="xs" fw={600} mb={6}>
            Data Source
          </Text>
          <Select
            size="xs"
            value={mode}
            onChange={(v) => onModeChange(v as DataSourceMode)}
            data={[
              { value: "all-devices", label: "All Devices" },
              { value: "per-device", label: "Per Device" },
              { value: "per-substrate", label: "Per Substrate" },
              {
                value: "per-varied-parameter",
                label: "Per Varied Parameter",
              },
            ]}
            searchable={false}
          />
        </div>

        {mode === "per-device" && deviceOptions.length > 0 && (
          <div>
            <Text size="xs" fw={600} mb={6}>
              Exclude Devices
            </Text>
            <MultiSelect
              size="xs"
              placeholder="Select devices to exclude..."
              data={deviceOptions}
              value={excludedDevices}
              onChange={onExcludedDevicesChange}
              searchable={false}
              maxDropdownHeight={150}
            />
          </div>
        )}

        {mode === "per-substrate" && substrateOptions.length > 0 && (
          <div>
            <Text size="xs" fw={600} mb={6}>
              Exclude Substrates
            </Text>
            <MultiSelect
              size="xs"
              placeholder="Select substrates to exclude..."
              data={substrateOptions}
              value={excludedSubstrates}
              onChange={onExcludedSubstratesChange}
              searchable={false}
              maxDropdownHeight={150}
            />
          </div>
        )}

        <Text size="xs" c="dimmed">
          {mode === "all-devices" &&
            `Analyzing ${experiment.devicesPerSubstrate * experiment.numSubstrates} total devices`}
          {mode === "per-device" &&
            `Analyzing ${deviceOptions.length - excludedDevices.length} devices`}
          {mode === "per-substrate" &&
            `Analyzing ${experiment.substrates.length - excludedSubstrates.length} substrates`}
          {mode === "per-varied-parameter" &&
            "Analyzing data grouped by varied parameters"}
        </Text>
      </Stack>
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Plot Widget Component
// ─────────────────────────────────────────────────────────────────────────────

function PlotWidgetComponent({
  widget,
  onMouseDownDrag,
  onMouseDownResize,
  onDelete,
  isSelected,
  onSelect,
}: {
  widget: PlotWidget
  onMouseDownDrag: (e: React.MouseEvent) => void
  onMouseDownResize: (e: React.MouseEvent) => void
  onDelete: () => void
  isSelected: boolean
  onSelect: () => void
}) {
  const chartRef = useRef<EChartsReact>(null)

  // Generate plot data based on type
  const chartOption = useMemo(() => {
    switch (widget.type) {
      case "boxplot":
        return generateBoxPlotOption("Annealing Temp")
      case "jv-curve":
        return generateJVCurveOption()
      case "scatter":
        return generateScatterPlotOption()
      case "bar":
        return generateBarChartOption()
      default:
        return generateBoxPlotOption("Parameter")
    }
  }, [widget.type])

  useEffect(() => {
    // Resize chart when widget dimensions change
    chartRef.current?.getEchartsInstance().resize()
  }, [])

  return (
    <Paper
      withBorder
      shadow={isSelected ? "md" : "xs"}
      style={{
        position: "absolute",
        left: widget.x,
        top: widget.y,
        width: widget.width,
        height: widget.height,
        cursor: "default",
        borderColor: isSelected ? "var(--mantine-color-blue-5)" : undefined,
        borderWidth: isSelected ? 2 : 1,
        overflow: "hidden",
        background: "white",
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      {/* Header */}
      <Group
        justify="space-between"
        px="xs"
        py={4}
        style={{
          background: "var(--mantine-color-gray-0)",
          borderBottom: "1px solid var(--mantine-color-gray-3)",
          cursor: "grab",
          flexShrink: 0,
        }}
        onMouseDown={onMouseDownDrag}
      >
        <Group gap="xs">
          <IconGripVertical size={14} color="var(--mantine-color-gray-5)" />
          <Text
            size="xs"
            fw={500}
            truncate
            style={{ maxWidth: widget.width - 80 }}
          >
            {widget.title}
          </Text>
        </Group>
        <ActionIcon
          size="xs"
          variant="subtle"
          color="red"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <IconX size={12} />
        </ActionIcon>
      </Group>

      {/* Chart */}
      <Box style={{ flex: 1, width: "100%", minHeight: 0 }}>
        <EChartsReact
          ref={chartRef}
          option={chartOption}
          style={{ width: "100%", height: "100%" }}
          opts={{ renderer: "canvas" }}
        />
      </Box>

      {/* Resize Handle */}
      <Box
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: "se-resize",
          background:
            "linear-gradient(135deg, transparent 50%, var(--mantine-color-gray-4) 50%)",
          pointerEvents: "auto",
        }}
        onMouseDown={onMouseDownResize}
      />
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

const GRID_SIZE = 20 // snap grid size
const MIN_WIDGET_SIZE = 200

export function AnalysisPage() {
  const { experiments, setActiveEntity } = useAppContext()
  const [selectedExperimentId, setSelectedExperimentId] = useState<
    string | null
  >(null)
  const [dataSourceMode, setDataSourceMode] =
    useState<DataSourceMode>("all-devices")
  const [excludedDevices, setExcludedDevices] = useState<string[]>([])
  const [excludedSubstrates, setExcludedSubstrates] = useState<string[]>([])

  const [widgets, setWidgets] = useState<PlotWidget[]>(() => [
    // Initial example widgets
    {
      id: crypto.randomUUID(),
      type: "boxplot",
      title: "PCE Distribution by Annealing Temp",
      x: 20,
      y: 20,
      width: 400,
      height: 320,
    },
    {
      id: crypto.randomUUID(),
      type: "jv-curve",
      title: "J-V Characteristics",
      x: 440,
      y: 20,
      width: 450,
      height: 320,
    },
    {
      id: crypto.randomUUID(),
      type: "scatter",
      title: "Annealing Temp vs PCE",
      x: 20,
      y: 360,
      width: 380,
      height: 300,
    },
    {
      id: crypto.randomUUID(),
      type: "bar",
      title: "Layer Contributions",
      x: 420,
      y: 360,
      width: 350,
      height: 300,
    },
  ])

  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null)
  const [dragState, setDragState] = useState<DragState>(null)
  const [resizeState, setResizeState] = useState<ResizeState>(null)
  const planeRef = useRef<HTMLDivElement>(null)

  const selectExperiment = (id: string | null) => {
    setSelectedExperimentId(id)
    setActiveEntity(id ? { kind: "experiment", id } : null)
  }

  const selectedExperiment = experiments.find(
    (e) => e.id === selectedExperimentId,
  )

  // Snap to grid helper
  const snapToGrid = (value: number): number => {
    return Math.round(value / GRID_SIZE) * GRID_SIZE
  }

  // Handle drag start
  const handleDragStart = (widgetId: string, e: React.MouseEvent) => {
    e.preventDefault()
    const widget = widgets.find((w) => w.id === widgetId)
    if (!widget) {
      return
    }

    setDragState({
      widgetId,
      startX: e.clientX,
      startY: e.clientY,
      startWidgetX: widget.x,
      startWidgetY: widget.y,
    })
    setSelectedWidgetId(widgetId)
  }

  // Handle resize start
  const handleResizeStart = (widgetId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const widget = widgets.find((w) => w.id === widgetId)
    if (!widget) {
      return
    }

    setResizeState({
      widgetId,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: widget.width,
      startHeight: widget.height,
    })
    setSelectedWidgetId(widgetId)
  }

  // Handle mouse move for drag/resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragState) {
        const deltaX = e.clientX - dragState.startX
        const deltaY = e.clientY - dragState.startY

        setWidgets((prev) =>
          prev.map((w) => {
            if (w.id !== dragState.widgetId) {
              return w
            }
            return {
              ...w,
              x: snapToGrid(Math.max(0, dragState.startWidgetX + deltaX)),
              y: snapToGrid(Math.max(0, dragState.startWidgetY + deltaY)),
            }
          }),
        )
      }

      if (resizeState) {
        const deltaX = e.clientX - resizeState.startX
        const deltaY = e.clientY - resizeState.startY

        setWidgets((prev) =>
          prev.map((w) => {
            if (w.id !== resizeState.widgetId) {
              return w
            }
            return {
              ...w,
              width: snapToGrid(
                Math.max(MIN_WIDGET_SIZE, resizeState.startWidth + deltaX),
              ),
              height: snapToGrid(
                Math.max(MIN_WIDGET_SIZE, resizeState.startHeight + deltaY),
              ),
            }
          }),
        )
      }
    }

    const handleMouseUp = () => {
      setDragState(null)
      setResizeState(null)
    }

    if (dragState || resizeState) {
      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [dragState, resizeState, snapToGrid])

  // Add new widget
  const addWidget = (type: PlotWidget["type"]) => {
    const newWidget: PlotWidget = {
      id: crypto.randomUUID(),
      type,
      title:
        type === "boxplot"
          ? "Box Plot"
          : type === "jv-curve"
            ? "J-V Curve"
            : type === "scatter"
              ? "Scatter Plot"
              : "Bar Chart",
      x: snapToGrid(20 + widgets.length * 20),
      y: snapToGrid(20 + widgets.length * 20),
      width: 400,
      height: 300,
    }
    setWidgets((prev) => [...prev, newWidget])
    setSelectedWidgetId(newWidget.id)
  }

  // Delete widget
  const deleteWidget = (widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId))
    if (selectedWidgetId === widgetId) {
      setSelectedWidgetId(null)
    }
  }

  return (
    <Box
      style={{
        display: "flex",
        height: "calc(100vh - 60px)",
        flexDirection: "column",
      }}
    >
      <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Main: Plot Plane */}
        <Box
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Toolbar */}
          <Group
            p="sm"
            style={{
              borderBottom: "1px solid var(--mantine-color-default-border)",
              background: "white",
            }}
          >
            <Text size="sm" fw={500}>
              Add Plot:
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => addWidget("boxplot")}
            >
              Box Plot
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => addWidget("jv-curve")}
            >
              J-V Curve
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => addWidget("scatter")}
            >
              Scatter
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => addWidget("bar")}
            >
              Bar Chart
            </Button>
            <Divider orientation="vertical" />
            <Text size="xs" c="dimmed">
              {widgets.length} plot{widgets.length !== 1 ? "s" : ""} • Drag to
              move, corner to resize
            </Text>
          </Group>

          {/* Plot Plane */}
          <Box
            ref={planeRef}
            style={{
              flex: 1,
              position: "relative",
              overflow: "auto",
              background: `
                linear-gradient(to right, var(--mantine-color-gray-2) 1px, transparent 1px),
                linear-gradient(to bottom, var(--mantine-color-gray-2) 1px, transparent 1px)
              `,
              backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
              backgroundColor: "var(--mantine-color-gray-0)",
            }}
            onClick={() => setSelectedWidgetId(null)}
          >
            {/* Widgets */}
            {widgets.map((widget) => (
              <PlotWidgetComponent
                key={widget.id}
                widget={widget}
                onMouseDownDrag={(e) => handleDragStart(widget.id, e)}
                onMouseDownResize={(e) => handleResizeStart(widget.id, e)}
                onDelete={() => deleteWidget(widget.id)}
                isSelected={selectedWidgetId === widget.id}
                onSelect={() => setSelectedWidgetId(widget.id)}
              />
            ))}

            {/* Empty state */}
            {widgets.length === 0 && (
              <Box
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  textAlign: "center",
                }}
              >
                <IconChartBar size={64} color="var(--mantine-color-gray-4)" />
                <Text size="lg" c="dimmed" mt="md">
                  No plots yet
                </Text>
                <Text size="sm" c="dimmed" mt="xs">
                  Use the toolbar above to add plots
                </Text>
              </Box>
            )}
          </Box>
        </Box>

        {/* Right Sidebar: Experiment & Configuration */}
        <Box
          style={{
            width: 300,
            borderLeft: "1px solid var(--mantine-color-default-border)",
            display: "flex",
            flexDirection: "column",
            background: "white",
            minHeight: 0,
          }}
        >
          {/* Experiment List Header */}
          <Group
            justify="space-between"
            p="md"
            style={{
              borderBottom: "1px solid var(--mantine-color-default-border)",
              flexShrink: 0,
            }}
          >
            <Text size="sm" fw={600}>
              Experiments
            </Text>
          </Group>

          {/* Experiment List */}
          <ScrollArea
            style={{
              flex: 1,
              borderBottom: "1px solid var(--mantine-color-default-border)",
              minHeight: 0,
            }}
            p="sm"
          >
            <Stack gap="sm">
              {experiments.length === 0 ? (
                <Paper
                  p="lg"
                  ta="center"
                  style={{ background: "var(--mantine-color-gray-0)" }}
                >
                  <Text size="sm" c="dimmed">
                    No experiments
                  </Text>
                </Paper>
              ) : (
                experiments.map((exp) => (
                  <ExperimentListItem
                    key={exp.id}
                    experiment={exp}
                    isSelected={selectedExperimentId === exp.id}
                    onSelect={() => selectExperiment(exp.id)}
                  />
                ))
              )}
            </Stack>
          </ScrollArea>

          {/* Data Source Configuration */}
          <Box
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--mantine-color-default-border)",
              overflow: "auto",
              maxHeight: "40%",
            }}
            p="sm"
          >
            <DataSourceConfigPanel
              mode={dataSourceMode}
              onModeChange={setDataSourceMode}
              experiment={selectedExperiment ?? null}
              excludedDevices={excludedDevices}
              onExcludedDevicesChange={setExcludedDevices}
              excludedSubstrates={excludedSubstrates}
              onExcludedSubstratesChange={setExcludedSubstrates}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
