# iMessage MCP Server

MCP server for reading iMessages, SMS, and RCS messages - including mixed group chats with Android users.

## Features

- Read iMessage, SMS, and RCS conversations
- **Handles mixed group chats** (groups with both iPhone and Android users)
- Search by contact name, phone number, or group name
- View recent messages across all conversations

## Installation

```bash
npm install
```

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imessage": {
      "command": "node",
      "args": ["/path/to/messages/src/index.js"]
    }
  }
}
```

## Requirements

- macOS with Messages app
- Full Disk Access permission for Claude Desktop (System Settings > Privacy & Security > Full Disk Access)

## Tools

- `list_conversations` - List all conversations
- `search_conversations` - Search by name/phone/group name
- `read_messages` - Read messages from a conversation
- `get_recent_messages` - Get recent messages across all chats
