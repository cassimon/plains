# Plains Chat Widget

The Plains application includes a floating chat widget that provides assistance to users. The widget is a dummy chatbot integrated into the application.

## Features

- **Floating Chat Button**: Located at the bottom-right of the screen
- **Conversational Interface**: Modal-based chat window with message history
- **Keyword-Based Responses**: Simple NLP that recognizes topics like:
  - Experiments
  - Materials
  - Solutions
  - Analysis
  - Help/General questions

## Usage

### For Users

The chat widget appears as a floating button in the bottom-right corner of the application. Simply:

1. Click the "Chat" button to open the chat window
2. Type your message in the input field
3. Press Enter or click "Send" to send your message
4. The assistant will respond with relevant information about the topic

### Topics the Bot Recognizes

- **Experiments**: "Tell me about experiments", "How do I create an experiment?"
- **Materials**: "How do I manage materials?", "What is inventory?"
- **Analysis**: "How can I analyze results?", "Tell me about plots"
- **Help**: "Help", "How can you assist me?"

## Implementation Details

### Component Location
- **File**: `src/components/ChatWidget.tsx`
- **Exports**: `ChatWidgetComponent` - The main floating chat widget
- **Root Integration**: Added to `src/routes/__root.tsx` for global availability

### Technology Stack

- **UI Framework**: Mantine Components (Button, Paper, TextInput, ScrollArea, etc.)
- **State Management**: React hooks (useState, useRef, useEffect)
- **Styling**: Responsive design with theme adaptation (light/dark mode)
- **Icons**: @tabler/icons-react (MessageCircle, Send, X)

### Response Generation

The bot uses simple keyword matching to categorize user messages:

```typescript
generateBotResponse(userMessage: string): string
```

This function:
1. Converts the message to lowercase
2. Checks for keywords related to different topics
3. Selects a random response from the appropriate category
4. Returns a contextual response

### Mock Rasa Server (Optional)

If you want to run a mock Rasa server for future integration:

```bash
npm run dev-rasa
```

This uses the `mock-rasa-server.js` file which provides a Socket.IO server mimicking Rasa behavior.

## Running the Application

### Standard Development
```bash
npm run dev
```

### With Both App and Mock Chat Server
```bash
npm run dev:with-chat
```
This runs both the Vite dev server and the mock Rasa server concurrently.

## Future Enhancements

The current implementation could be extended to:

1. **Connect to Real Rasa Server**: Replace keyword matching with actual NLU
2. **Context Awareness**: Keep track of conversation context
3. **User Preferences**: Save user preferences between sessions
4. **Analytics**: Track common questions and user interactions
5. **Multi-language Support**: Add support for multiple languages
6. **Custom Actions**: Integrate with backend APIs for dynamic responses

## Styling & Customization

The chat widget automatically adapts to the application's theme (light/dark mode) and uses the Mantine theme colors:

- Primary Color: `#228be6` (Blue)
- Dark Background: `#1f1f23`
- Light Background: `#ffffff`
- Message Bubble Colors:
  - User: Blue (`#228be6`)
  - Bot: Gray (`#f3f3f3` / `#2a2a2f`)

## Environment Variables

- `VITE_RASA_SERVER_URL`: URL to the Rasa server (default: `http://localhost:5005`)
  - Set in `.env` file
  - Used only if connecting to a real Rasa server

## Files Modified

1. **src/components/ChatWidget.tsx** - New chat widget component
2. **src/routes/__root.tsx** - Integrated widget into root layout
3. **mock-rasa-server.js** - Optional mock server implementation
4. **.env** - Added VITE_RASA_SERVER_URL configuration
5. **package.json** - Added dev scripts and dependencies

## Dependencies

- `@mantine/core` - UI components
- `@tabler/icons-react` - Icons
- `next-themes` - Theme detection
- `express` - (dev) Mock server framework
- `cors` - (dev) Cross-origin support
- `concurrently` - (dev) Run multiple processes

---

For questions or feature requests, please refer to the Plains documentation or contact the development team.
