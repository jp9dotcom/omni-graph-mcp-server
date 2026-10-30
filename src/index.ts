#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { getOAuth2Client } from './auth.js';
import { searchDrive } from './tools/drive.js';
import { readDoc, createDoc } from './tools/docs.js';
import { readRecentEmails, sendEmail } from './tools/gmail.js';

async function main() {
  // If running directly in a terminal, allow interactive token acquisition.
  // If spawned by an MCP client over stdio, stdin is reserved for JSON-RPC messages.
  const isInteractive = Boolean(process.stdin.isTTY);
  const auth = await getOAuth2Client(isInteractive);

  // Create MCP Server instance
  const server = new Server(
    {
      name: 'google-workspace-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools list handler with strict JSON schemas
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search_drive',
          description:
            'Searches Google Drive for files matching a query string and returns matching file names and IDs.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'The search query string (e.g., file name keyword or Drive query syntax).',
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        {
          name: 'read_doc',
          description:
            'Reads a Google Doc by its documentId and returns its full plain text content.',
          inputSchema: {
            type: 'object',
            properties: {
              documentId: {
                type: 'string',
                description: 'The unique ID of the Google Doc to read.',
              },
            },
            required: ['documentId'],
            additionalProperties: false,
          },
        },
        {
          name: 'create_doc',
          description:
            'Creates a new Google Doc with the specified title, inserts the initial text content, and returns the document link.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the new Google Doc.',
              },
              content: {
                type: 'string',
                description: 'The text content to insert into the new document.',
              },
            },
            required: ['title', 'content'],
            additionalProperties: false,
          },
        },
        {
          name: 'read_recent_emails',
          description:
            'Retrieves recent Gmail messages and returns their subjects, senders, dates, snippets, and plain text bodies.',
          inputSchema: {
            type: 'object',
            properties: {
              maxResults: {
                type: 'integer',
                description:
                  'Maximum number of recent emails to retrieve (e.g. 5 or 10).',
                default: 10,
              },
            },
            required: ['maxResults'],
            additionalProperties: false,
          },
        },
        {
          name: 'send_email',
          description:
            'Constructs and sends an email via the Gmail API to a recipient with a subject and plain text body.',
          inputSchema: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'Recipient email address.',
              },
              subject: {
                type: 'string',
                description: 'Subject of the email.',
              },
              body: {
                type: 'string',
                description: 'Plain text content of the email body.',
              },
            },
            required: ['to', 'subject', 'body'],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  // Handle tool execution requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_drive': {
          if (!args || typeof args.query !== 'string') {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Invalid arguments: "query" (string) is required.'
            );
          }
          const files = await searchDrive(auth, args.query);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(files, null, 2),
              },
            ],
          };
        }

        case 'read_doc': {
          if (!args || typeof args.documentId !== 'string') {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Invalid arguments: "documentId" (string) is required.'
            );
          }
          const doc = await readDoc(auth, args.documentId);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(doc, null, 2),
              },
            ],
          };
        }

        case 'create_doc': {
          if (
            !args ||
            typeof args.title !== 'string' ||
            typeof args.content !== 'string'
          ) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Invalid arguments: "title" (string) and "content" (string) are required.'
            );
          }
          const result = await createDoc(auth, args.title, args.content);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'read_recent_emails': {
          const maxResults =
            typeof args?.maxResults === 'number' ? args.maxResults : 10;
          const emails = await readRecentEmails(auth, maxResults);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(emails, null, 2),
              },
            ],
          };
        }

        case 'send_email': {
          if (
            !args ||
            typeof args.to !== 'string' ||
            typeof args.subject !== 'string' ||
            typeof args.body !== 'string'
          ) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Invalid arguments: "to" (string), "subject" (string), and "body" (string) are required.'
            );
          }
          const result = await sendEmail(auth, args.to, args.subject, args.body);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error: unknown) {
      if (error instanceof McpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool "${name}": ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect server over standard I/O transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[INFO] Google Workspace MCP Server running on stdio');
}

main().catch((err: unknown) => {
  console.error('[FATAL] Failed to start Google Workspace MCP Server:', err);
  process.exit(1);
});
