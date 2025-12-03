# iMessage MCP Server

MCP server for Claude Desktop that reads iMessages, SMS, and RCS messages - including mixed group chats with Android users.

## Why This Exists

Other iMessage MCP connectors fail to read:
- **RCS messages** (newer Android-to-iPhone messages)
- **Group chats with Android users** (SMS/MMS groups)
- Messages stored in `attributedBody` instead of plain text

This server handles all of these by:
- Querying SMS, RCS, and iMessage conversations
- Decoding binary `attributedBody` blobs to extract message text
- Merging duplicate chat IDs that appear for mixed-protocol groups

## Features

- List all conversations (iMessage, SMS, RCS)
- Search by contact name, phone number, or group name
- Read messages from any conversation type
- Get recent messages across all chats
- Properly handles mixed iPhone/Android group chats

## Installation

```bash
git clone https://github.com/DavidGreigQC/imessage-mcp-server.git
cd imessage-mcp-server
npm install
```

## Setup with Claude Desktop

1. Open Claude Desktop config:
   ```
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```

2. Add the server:
   ```json
   {
     "mcpServers": {
       "imessage": {
         "command": "node",
         "args": ["/path/to/imessage-mcp-server/src/index.js"]
       }
     }
   }
   ```

3. Grant Full Disk Access to Claude Desktop:
   - System Settings > Privacy & Security > Full Disk Access
   - Add Claude Desktop

4. Restart Claude Desktop

## Usage Examples

Once configured, you can ask Claude things like:

- "List my recent conversations"
- "Search for messages from John"
- "Read messages from the FBLA group chat"
- "Show me messages from the last 24 hours"

## Available Tools

| Tool | Description |
|------|-------------|
| `list_conversations` | List all conversations with last activity time |
| `search_conversations` | Search by name, phone, or group name |
| `read_messages` | Read messages from a specific conversation |
| `get_recent_messages` | Get recent messages across all chats |

## Requirements

- macOS (tested on Sonoma/Sequoia)
- Node.js 18+
- Claude Desktop with Full Disk Access
- Messages app with message history

## How It Works

The server reads directly from the macOS Messages database (`~/Library/Messages/chat.db`). For RCS and some iMessage conversations, message text is stored in a binary `attributedBody` field rather than plain text - this server decodes that binary format to extract the actual message content.

## License

MIT
