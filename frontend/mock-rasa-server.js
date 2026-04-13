#!/usr/bin/env node

/**
 * Mock Rasa Server for Development
 * Simulates a Rasa chatbot server with Socket.IO
 * Run this with: node mock-rasa-server.js
 */

import { createServer } from "node:http"
import cors from "cors"
import express from "express"
import { Server as SocketIOServer } from "socket.io"

const app = express()
const server = createServer(app)
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  path: "/socket.io/",
})

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 5005

// Dummy bot responses
const botResponses = {
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

function generateResponse(userMessage) {
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

  const responses = botResponses[category]
  return responses[Math.floor(Math.random() * responses.length)]
}

// Handle Socket.IO connections
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id)

  // Handle user messages
  socket.on("user_uttered", (data) => {
    console.log("User message:", data)

    // Generate bot response
    const userMessage = data.message || ""
    const botMessage = generateResponse(userMessage)

    // Send response back to client
    socket.emit("bot_uttered", {
      text: botMessage,
    })

    console.log("Bot response:", botMessage)
  })

  // Send initial greeting on connection
  socket.emit("bot_uttered", {
    text: "Hello! I'm the Plains Assistant. How can I help you today?",
  })

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id)
  })

  socket.on("error", (error) => {
    console.error("Socket error:", error)
  })
})

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

// Start server
server.listen(PORT, () => {
  console.log(`🤖 Mock Rasa Server running on http://localhost:${PORT}`)
  console.log("   Socket.IO path: /socket.io/")
  console.log("\nBot is ready to respond to messages!")
  console.log("Topics: experiments, materials, analysis, help")
})
