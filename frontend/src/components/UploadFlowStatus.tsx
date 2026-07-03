import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudUpload,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  countDoneSteps,
  getUploadFlowSteps,
  isUploadFlowComplete,
  type StepState,
  type UploadFlowStep,
} from "@/lib/uploadFlow"
import { useAppContext } from "@/store/AppContext"
import { UploadFlowTargetPicker } from "./UploadFlowTargetPicker"

// Inject the critical-status pulse animation once.
if (
  typeof document !== "undefined" &&
  !document.getElementById("upload-flow-pulse")
) {
  const style = document.createElement("style")
  style.id = "upload-flow-pulse"
  style.textContent = `
    @keyframes upload-flow-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(224, 49, 49, 0.5); }
      70%  { box-shadow: 0 0 0 6px rgba(224, 49, 49, 0); }
      100% { box-shadow: 0 0 0 0 rgba(224, 49, 49, 0); }
    }
    .upload-flow-bubble { animation: upload-flow-pulse 2s ease-out infinite; }
  `
  document.head.appendChild(style)
}

const STEP_LABELS: Record<UploadFlowStep, string> = {
  process: "Process",
  experiment: "Experiment",
  upload: "Upload",
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <ThemeIcon size="sm" radius="xl" color="green">
        <IconCheck size={14} />
      </ThemeIcon>
    )
  }
  if (state === "error") {
    return (
      <ThemeIcon size="sm" radius="xl" color="red">
        <IconAlertTriangle size={14} />
      </ThemeIcon>
    )
  }
  if (state === "active") {
    return (
      <ThemeIcon size="sm" radius="xl" color="red" variant="filled">
        <IconLoader2 size={14} />
      </ThemeIcon>
    )
  }
  return (
    <ThemeIcon size="sm" radius="xl" color="gray" variant="light">
      <IconLoader2 size={14} opacity={0.4} />
    </ThemeIcon>
  )
}

export function UploadFlowStatus() {
  const {
    uploadFlow,
    cancelUploadFlow,
    processes,
    experiments,
    results,
    setActiveEntity,
    updateLastSelected,
    setPendingCollectionLink,
  } = useAppContext()
  const navigate = useNavigate()
  const [opened, setOpened] = useState(false)

  const steps = useMemo(() => {
    if (!uploadFlow) {
      return null
    }
    return getUploadFlowSteps(uploadFlow, { processes, experiments, results })
  }, [uploadFlow, processes, experiments, results])

  // On completion: notify once and auto-clear the flow after a short delay.
  const complete = steps ? isUploadFlowComplete(steps) : false
  const notifiedRef = useRef(false)
  useEffect(() => {
    if (!complete) {
      notifiedRef.current = false
      return
    }
    if (notifiedRef.current) {
      return
    }
    notifiedRef.current = true
    notifications.show({
      title: "Upload complete",
      message: "Your files were uploaded to NOMAD.",
      color: "green",
    })
    const timer = window.setTimeout(() => cancelUploadFlow(), 5000)
    return () => window.clearTimeout(timer)
  }, [complete, cancelUploadFlow])

  if (!uploadFlow || !steps) {
    return null
  }

  const done = countDoneSteps(steps)
  const stepOrder: UploadFlowStep[] = ["process", "experiment", "upload"]

  const handleGoToResults = () => {
    if (!uploadFlow.experimentId) {
      return
    }
    setPendingCollectionLink({
      collectionId: "",
      planeId: "",
      kind: "result",
      selectedExperimentId: uploadFlow.experimentId,
      openAddResults: true,
      requestId: crypto.randomUUID(),
    })
    setActiveEntity({ kind: "experiment", id: uploadFlow.experimentId })
    updateLastSelected("experiment", uploadFlow.experimentId)
    setOpened(false)
    void navigate({ to: "/results" })
  }

  const handleCancel = () => {
    setOpened(false)
    cancelUploadFlow()
  }

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={320}
      position="bottom"
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <Badge
          className="upload-flow-bubble"
          color="red"
          variant="filled"
          size="lg"
          leftSection={<IconCloudUpload size={14} />}
          style={{ cursor: "pointer" }}
          onClick={() => setOpened((o) => !o)}
        >
          File Upload · {done}/3
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={700} size="sm">
              File Upload
            </Text>
            <Tooltip label="Abort upload" withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                onClick={handleCancel}
                aria-label="Abort upload"
              >
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>

          {/* 3-step tracker */}
          <Stack gap={6}>
            {stepOrder.map((step) => (
              <Group key={step} gap="xs" wrap="nowrap">
                <StepIcon state={steps[step]} />
                <Text
                  size="sm"
                  fw={steps[step] === "active" ? 600 : 400}
                  c={steps[step] === "pending" ? "dimmed" : undefined}
                >
                  {STEP_LABELS[step]}
                </Text>
              </Group>
            ))}
          </Stack>

          <Divider />

          {/* Process / Experiment selection + create */}
          <UploadFlowTargetPicker onNavigateAway={() => setOpened(false)} />

          {/* Jump to Results to perform the upload */}
          {steps.experiment === "done" && steps.upload !== "done" && (
            <Button
              size="xs"
              leftSection={<IconCloudUpload size={14} />}
              onClick={handleGoToResults}
            >
              Go to results & upload
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
