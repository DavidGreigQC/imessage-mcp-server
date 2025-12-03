#!/usr/bin/env node

/**
 * iMessage MCP Server
 * Reads iMessages, SMS, and RCS messages - including mixed group chats with Android users
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import os from 'os';

class iMessageServer {
  constructor() {
    this.server = new Server(
      { name: 'imessage-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.dbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
    this.setupHandlers();
  }

  // Convert days back to Apple's nanosecond timestamp format
  getAppleTimestamp(daysBack) {
    const appleEpoch = 978307200; // Seconds between 1970 and 2001
    const nowAppleSeconds = Math.floor(Date.now() / 1000) - appleEpoch;
    const thresholdSeconds = nowAppleSeconds - (daysBack * 24 * 60 * 60);
    return thresholdSeconds * 1000000000; // Convert to nanoseconds
  }

  async openDb() {
    return open({
      filename: this.dbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READONLY,
    });
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_conversations',
          description: 'List all conversations (individual and group chats). Shows iMessage, SMS, and RCS.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max conversations to return (default: 50)', default: 50 },
              include_sms: { type: 'boolean', description: 'Include SMS/RCS chats (default: true)', default: true },
            },
          },
        },
        {
          name: 'search_conversations',
          description: 'Search for conversations by name, phone number, or group name. Works with SMS/RCS groups that include Android users.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term (name, phone, or group name)' },
              limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_messages',
          description: 'Read messages from a conversation. Use chat_id from list/search results for groups, or phone/email for individuals.',
          inputSchema: {
            type: 'object',
            properties: {
              identifier: { type: 'string', description: 'Chat ID (for groups) or phone/email (for individuals)' },
              limit: { type: 'number', description: 'Max messages (default: 50)', default: 50 },
              days_back: { type: 'number', description: 'Days to look back (default: 30)', default: 30 },
            },
            required: ['identifier'],
          },
        },
        {
          name: 'get_recent_messages',
          description: 'Get most recent messages across all conversations',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max messages (default: 30)', default: 30 },
              hours_back: { type: 'number', description: 'Hours to look back (default: 24)', default: 24 },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_conversations':
            return await this.listConversations(args.limit, args.include_sms);
          case 'search_conversations':
            return await this.searchConversations(args.query, args.limit);
          case 'read_messages':
            return await this.readMessages(args.identifier, args.limit, args.days_back);
          case 'get_recent_messages':
            return await this.getRecentMessages(args.limit, args.hours_back);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    });
  }

  async listConversations(limit = 50, includeSms = true) {
    const db = await this.openDb();

    try {
      const serviceFilter = includeSms ? '' : "AND c.service_name = 'iMessage'";

      // Get conversations with their most recent message
      const conversations = await db.all(`
        SELECT
          c.ROWID as chat_id,
          c.display_name,
          c.chat_identifier,
          c.service_name,
          c.group_id,
          (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID) as participant_count,
          (SELECT MAX(m.date) FROM chat_message_join cmj
           JOIN message m ON cmj.message_id = m.ROWID
           WHERE cmj.chat_id = c.ROWID) as last_message_date
        FROM chat c
        WHERE 1=1 ${serviceFilter}
        GROUP BY c.group_id
        ORDER BY last_message_date DESC
        LIMIT ?
      `, [limit]);

      await db.close();

      const formatted = conversations.map(c => ({
        chat_id: c.chat_id,
        name: c.display_name || c.chat_identifier,
        type: c.participant_count > 1 ? 'group' : 'individual',
        service: c.service_name,
        participants: c.participant_count,
        last_activity: c.last_message_date ?
          new Date((c.last_message_date / 1000000000 + 978307200) * 1000).toISOString() : null,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: formatted.length, conversations: formatted }, null, 2),
        }],
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async searchConversations(query, limit = 20) {
    const db = await this.openDb();

    try {
      // Search by display name, chat identifier, or participant phone/email
      const conversations = await db.all(`
        SELECT DISTINCT
          c.ROWID as chat_id,
          c.display_name,
          c.chat_identifier,
          c.service_name,
          c.group_id,
          (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID) as participant_count
        FROM chat c
        LEFT JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
        LEFT JOIN handle h ON chj.handle_id = h.ROWID
        WHERE c.display_name LIKE ?
           OR c.chat_identifier LIKE ?
           OR h.id LIKE ?
        GROUP BY COALESCE(c.group_id, c.ROWID)
        ORDER BY c.ROWID DESC
        LIMIT ?
      `, [`%${query}%`, `%${query}%`, `%${query}%`, limit]);

      // For each conversation, get participants
      const results = [];
      for (const conv of conversations) {
        const participants = await db.all(`
          SELECT h.id as identifier
          FROM chat_handle_join chj
          JOIN handle h ON chj.handle_id = h.ROWID
          WHERE chj.chat_id = ?
        `, [conv.chat_id]);

        results.push({
          chat_id: conv.chat_id,
          name: conv.display_name || conv.chat_identifier,
          type: conv.participant_count > 1 ? 'group' : 'individual',
          service: conv.service_name,
          participants: participants.map(p => p.identifier),
        });
      }

      await db.close();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, found: results.length, results }, null, 2),
        }],
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async readMessages(identifier, limit = 50, daysBack = 30) {
    const db = await this.openDb();

    try {
      const threshold = this.getAppleTimestamp(daysBack);
      let messages;
      let conversationInfo;

      // Check if it's a chat_id (numeric) or phone/email
      const isNumeric = /^\d+$/.test(identifier);

      if (isNumeric) {
        // It's a chat_id - could be a group chat
        const chatId = parseInt(identifier);

        // Get chat info
        const chatInfo = await db.get(`
          SELECT display_name, chat_identifier, service_name, group_id
          FROM chat WHERE ROWID = ?
        `, [chatId]);

        if (!chatInfo) {
          throw new Error(`Chat not found: ${chatId}`);
        }

        // Get all chat IDs with the same group_id (handles SMS/RCS duplicates)
        const relatedChats = await db.all(`
          SELECT ROWID FROM chat WHERE group_id = ?
        `, [chatInfo.group_id]);

        const chatIds = relatedChats.map(c => c.ROWID);

        messages = await db.all(`
          SELECT
            datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as timestamp,
            m.text,
            m.is_from_me,
            h.id as sender,
            m.service
          FROM chat_message_join cmj
          JOIN message m ON cmj.message_id = m.ROWID
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          WHERE cmj.chat_id IN (${chatIds.join(',')})
            AND m.date > ?
            AND m.text IS NOT NULL AND m.text != ''
          ORDER BY m.date DESC
          LIMIT ?
        `, [threshold, limit]);

        conversationInfo = {
          name: chatInfo.display_name || chatInfo.chat_identifier,
          type: 'group',
          service: chatInfo.service_name,
          chat_ids: chatIds,
        };
      } else {
        // It's a phone/email - individual conversation
        const cleanNumber = identifier.replace(/[^0-9+]/g, '');

        // Find all handles for this identifier
        const handles = await db.all(`
          SELECT ROWID, id FROM handle
          WHERE id LIKE ? OR id LIKE ? OR id LIKE ?
        `, [`%${identifier}%`, `%${cleanNumber}%`, `%+${cleanNumber}%`]);

        if (handles.length === 0) {
          throw new Error(`Contact not found: ${identifier}`);
        }

        const handleIds = handles.map(h => h.ROWID);

        messages = await db.all(`
          SELECT
            datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as timestamp,
            m.text,
            m.is_from_me,
            h.id as sender,
            m.service
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          WHERE m.handle_id IN (${handleIds.join(',')})
            AND m.date > ?
            AND m.text IS NOT NULL AND m.text != ''
          ORDER BY m.date DESC
          LIMIT ?
        `, [threshold, limit]);

        conversationInfo = {
          name: identifier,
          type: 'individual',
          handles: handles.map(h => h.id),
        };
      }

      await db.close();

      const formattedMessages = messages.map(m => ({
        timestamp: m.timestamp,
        sender: m.is_from_me ? 'You' : (m.sender || 'Unknown'),
        text: m.text,
        service: m.service,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversation: conversationInfo,
            message_count: formattedMessages.length,
            messages: formattedMessages,
          }, null, 2),
        }],
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async getRecentMessages(limit = 30, hoursBack = 24) {
    const db = await this.openDb();

    try {
      const threshold = this.getAppleTimestamp(hoursBack / 24);

      const messages = await db.all(`
        SELECT
          datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as timestamp,
          m.text,
          m.is_from_me,
          h.id as sender,
          c.display_name as group_name,
          c.chat_identifier,
          c.service_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE m.date > ?
          AND m.text IS NOT NULL AND m.text != ''
        ORDER BY m.date DESC
        LIMIT ?
      `, [threshold, limit]);

      await db.close();

      const formattedMessages = messages.map(m => ({
        timestamp: m.timestamp,
        conversation: m.group_name || m.chat_identifier || m.sender || 'Unknown',
        sender: m.is_from_me ? 'You' : (m.sender || 'Unknown'),
        text: m.text,
        service: m.service_name,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            hours_back: hoursBack,
            count: formattedMessages.length,
            messages: formattedMessages,
          }, null, 2),
        }],
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('iMessage MCP Server running');
  }
}

const server = new iMessageServer();
server.run().catch(console.error);
