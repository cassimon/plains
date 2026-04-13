import {
  Box,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  useMantineColorScheme,
} from "@mantine/core"
import { IconMessageCircle, IconSend, IconX } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"

type ChatMessage = {
  id: string
  sender: "user" | "bot"
  text: string
  timestamp: Date
}

/**
 * Chat Widget Component - Floating Chat Interface
 * A simple chatbot that provides dummy responses
 */
export function ChatWidgetComponent() {
  const { colorScheme } = useMantineColorScheme()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "1",
      sender: "bot",
      text: "Hello! I'm the Plains Assistant. How can I help you today?",
      timestamp: new Date(),
    },
  ])
  const [inputValue, setInputValue] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  const generateBotResponse = (userMessage: string): string => {
    const responses: { [key: string]: string[] } = {
      greet: [
        "Hello! I'm the Plains Assistant. I can help you with information about your experiments and materials. What would you like to know?",
        "Hi there! How can I help you with your research today?",
      ],
      experiment: [
        "I can help you manage your experiments. You can create new experiments, upload results, and analyze data.",
        "Experiments are organized by name, date, and status (incomplete, ready, or finished).",
      ],
      material: [
        "I can help you manage materials in your inventory. You can add new materials with supplier information and purity levels.",
        "Materials are categorized by type and can be linked to your experiments.",
      ],
      analysis: [
        "You can analyze your experimental results using our interactive dashboard with ECharts visualizations.",
        "The analysis section supports box plots, J-V curves, scatter plots, and bar charts.",
      ],
      help: [
        "I'm here to help! You can ask me about experiments, materials, solutions, or any other aspect of the Plains application.",
        "What specific topic would you like help with - experiments, materials, results analysis, or something else?",
      ],
      default: [
        "I'm not sure I understand that question. Could you rephrase it?",
        "I can help with questions about experiments, materials, and analysis. Please try again.",
      ],
    }

    // Simple keyword matching for demo
    const lowerMessage = userMessage.toLowerCase()
    let category = "default"

    if (
      lowerMessage.includes("experiment") ||
      lowerMessage.includes("fabricate") ||
      lowerMessage.includes("substrate") ||
      lowerMessage.includes("device")
    ) {
      category = "experiment"
    } else if (
      lowerMessage.includes("material") ||
      lowerMessage.includes("inventory") ||
      lowerMessage.includes("supplier")
    ) {
      category = "material"
    } else if (
      lowerMessage.includes("solution") ||
      lowerMessage.includes("solvent")
    ) {
      category = "material"
    } else if (lowerMessage.includes("analys")) {
      category = "analysis"
    } else if (
      lowerMessage.includes("help") ||
      lowerMessage.includes("how") ||
      lowerMessage.includes("what can you")
    ) {
      category = "help"
    } else if (
      lowerMessage.includes("hi") ||
      lowerMessage.includes("hello") ||
      lowerMessage.includes("hey")
    ) {
      category = "greet"
    }

    const categoryResponses = responses[category]
    return categoryResponses[
      Math.floor(Math.random() * categoryResponses.length)
    ]
  }

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return

    // Add user message
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      text: inputValue,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInputValue("")
    setIsLoading(true)

    // Simulate bot response delay
    setTimeout(() => {
      const botResponse: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "bot",
        text: generateBotResponse(inputValue),
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, botResponse])
      setIsLoading(false)
    }, 500)
  }

  const isDark = colorScheme === "dark"
  const bgColor = isDark ? "#1f1f23" : "#ffffff"
  const botBgColor = isDark ? "#2a2a2f" : "#f3f3f3"
  const userBgColor = "#228be6"

  return (
    <>
      {/* Floating Chat Button */}
      <Box
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 1000,
        }}
      >
        {!isOpen && (
          <Button
            size="lg"
            radius="full"
            onClick={() => setIsOpen(true)}
            leftSection={<IconMessageCircle size={20} />}
            style={{
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
            }}
          >
            Chat
          </Button>
        )}

        {/* Chat Window */}
        {isOpen && (
          <Paper
            shadow="lg"
            radius="md"
            p={0}
            style={{
              width: 380,
              height: 500,
              display: "flex",
              flexDirection: "column",
              backgroundColor: bgColor,
              borderTop: "2px solid #228be6",
            }}
          >
            {/* Header */}
            <Group
              justify="space-between"
              p="sm"
              style={{
                borderBottom: `1px solid ${isDark ? "#2a2a2f" : "#e9ecef"}`,
                flexShrink: 0,
              }}
            >
              <Stack gap={2}>
                <Text size="sm" fw={600}>
                  Plains Assistant
                </Text>
                <Text size="xs" c="dimmed">
                  Ask me anything
                </Text>
              </Stack>
              <Button
                variant="subtle"
                size="xs"
                onClick={() => setIsOpen(false)}
                p={0}
              >
                <IconX size={16} />
              </Button>
            </Group>

            {/* Messages Area */}
            <ScrollArea
              ref={scrollRef}
              style={{
                flex: 1,
                minHeight: 0,
                padding: 12,
                backgroundColor: bgColor,
              }}
            >
              <Stack gap="sm">
                {messages.map((msg) => (
                  <Group
                    key={msg.id}
                    justify={msg.sender === "user" ? "flex-end" : "flex-start"}
                  >
                    <Paper
                      p="sm"
                      radius="md"
                      style={{
                        maxWidth: "75%",
                        background:
                          msg.sender === "user" ? userBgColor : botBgColor,
                        color: msg.sender === "user" ? "white" : "inherit",
                      }}
                    >
                      <Text size="sm">{msg.text}</Text>
                    </Paper>
                  </Group>
                ))}
                {isLoading && (
                  <Group justify="flex-start">
                    <Paper
                      p="sm"
                      radius="md"
                      style={{
                        background: botBgColor,
                      }}
                    >
                      <Text size="sm" c="dimmed">
                        Thinking...
                      </Text>
                    </Paper>
                  </Group>
                )}
              </Stack>
            </ScrollArea>

            {/* Input Area */}
            <Group
              p="sm"
              gap="xs"
              style={{
                borderTop: `1px solid ${isDark ? "#2a2a2f" : "#e9ecef"}`,
                flexShrink: 0,
              }}
            >
              <TextInput
                placeholder="Type a message..."
                value={inputValue}
                onChange={(e) => setInputValue(e.currentTarget.value)}
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    handleSendMessage()
                  }
                }}
                disabled={isLoading}
                style={{ flex: 1 }}
              />
              <Button
                size="sm"
                onClick={handleSendMessage}
                disabled={!inputValue.trim() || isLoading}
                rightSection={<IconSend size={14} />}
              >
                Send
              </Button>
            </Group>
          </Paper>
        )}
      </Box>
    </>
  )
}
