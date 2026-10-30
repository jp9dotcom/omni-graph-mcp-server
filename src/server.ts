import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';

import { vault, TeamMember } from './security/vault.js';
import {
  scanForSecrets,
  validateEmailRecipient,
  checkToolPermission,
} from './security/guardrails.js';
import { auditLogger } from './security/audit.js';
import { searchDrive } from './tools/drive.js';
import { readDoc, createDoc } from './tools/docs.js';
import { readRecentEmails, sendEmail } from './tools/gmail.js';
import { SCOPES } from './auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Track active client SSE sessions: sessionId -> { transport, user }
interface SessionData {
  transport: SSEServerTransport;
  server: Server;
  user: TeamMember;
}
const activeSessions = new Map<string, SessionData>();

/**
 * Creates a configured OAuth2Client for a specific team member from the vault.
 */
function getUserOAuthClient(user: TeamMember): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Server configuration error: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.');
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret, 'http://localhost');
  const tokens = vault.getGoogleTokens(user.id);

  if (!tokens) {
    throw new Error(`User ${user.id} has not yet authorized Google Workspace.`);
  }

  oauth2Client.setCredentials(tokens);

  // Auto-persist refreshed tokens into encrypted vault
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const existing = (vault.getGoogleTokens(user.id) as Record<string, unknown>) || {};
      vault.saveGoogleTokens(user.id, { ...existing, ...newTokens });
      console.log(`[VAULT] Auto-refreshed and encrypted tokens for ${user.id}`);
    } catch (err) {
      console.error(`[VAULT] Failed to persist refreshed tokens for ${user.id}:`, err);
    }
  });

  return oauth2Client;
}

/**
 * Creates an isolated MCP Server instance for a connected user with RBAC and guardrails.
 */
function createMcpServerForUser(user: TeamMember, clientIp: string): Server {
  const server = new Server(
    {
      name: `omnigraph-remote-mcp`,
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools filtered by user's RBAC role
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = [
      {
        name: 'search_drive',
        description: 'Searches Google Drive for files matching a query string and returns matching file names and IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword or Drive query syntax.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_doc',
        description: 'Reads a Google Doc by its documentId and returns its text content.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'The unique ID of the Google Doc to read.' },
          },
          required: ['documentId'],
        },
      },
      {
        name: 'create_doc',
        description: 'Creates a new Google Doc with the specified title and content, returning the document link.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The title of the document.' },
            content: { type: 'string', description: 'The initial text content.' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'read_recent_emails',
        description: 'Retrieves the latest Gmail messages with subjects, senders, dates, snippets, and bodies.',
        inputSchema: {
          type: 'object',
          properties: {
            maxResults: { type: 'integer', description: 'Maximum number of recent emails to retrieve (default: 10).' },
          },
          required: ['maxResults'],
        },
      },
      {
        name: 'send_email',
        description: 'Sends an email via Gmail API to a recipient with subject and body.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body text.' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    ];

    // Filter tools based on RBAC permissions
    const permittedTools = allTools.filter((t) => checkToolPermission(user.role, t.name).permitted);
    return { tools: permittedTools };
  });

  // Call tool with guardrails, RBAC, and audit logging
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    // 1. Enforce RBAC
    const rbac = checkToolPermission(user.role, name);
    if (!rbac.permitted) {
      auditLogger.log({
        userId: user.id,
        role: user.role,
        toolName: name,
        parameters: (args as Record<string, unknown>) || {},
        status: 'BLOCKED_BY_GUARDRAIL',
        durationMs: Date.now() - startTime,
        errorMessage: rbac.reason,
        ipAddress: clientIp,
      });
      throw new McpError(ErrorCode.InvalidRequest, rbac.reason || 'Unauthorized tool invocation.');
    }

    try {
      const auth = getUserOAuthClient(user);

      let resultText = '';

      switch (name) {
        case 'search_drive': {
          if (!args || typeof args.query !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments: "query" is required.');
          }
          const files = await searchDrive(auth, args.query);
          resultText = JSON.stringify(files, null, 2);
          break;
        }

        case 'read_doc': {
          if (!args || typeof args.documentId !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments: "documentId" is required.');
          }
          const doc = await readDoc(auth, args.documentId);
          resultText = JSON.stringify(doc, null, 2);
          break;
        }

        case 'create_doc': {
          if (!args || typeof args.title !== 'string' || typeof args.content !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments: "title" and "content" are required.');
          }

          // Guardrail: Data Loss Prevention (DLP) secret scan
          const dlp = scanForSecrets(args.content);
          if (dlp.hasLeak) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Guardrail Block: Document creation aborted. ${dlp.reason}`
            );
          }

          const result = await createDoc(auth, args.title, args.content);
          resultText = JSON.stringify(result, null, 2);
          break;
        }

        case 'read_recent_emails': {
          const maxResults = typeof args?.maxResults === 'number' ? args.maxResults : 10;
          const emails = await readRecentEmails(auth, maxResults);
          resultText = JSON.stringify(emails, null, 2);
          break;
        }

        case 'send_email': {
          if (!args || typeof args.to !== 'string' || typeof args.subject !== 'string' || typeof args.body !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments: "to", "subject", and "body" are required.');
          }

          // Guardrail 1: Whitelist domain policy
          const domainCheck = validateEmailRecipient(args.to);
          if (!domainCheck.allowed) {
            throw new McpError(ErrorCode.InvalidParams, domainCheck.reason || 'Blocked by domain whitelist.');
          }

          // Guardrail 2: Secret leakage check
          const secretCheck = scanForSecrets(args.body);
          if (secretCheck.hasLeak) {
            throw new McpError(ErrorCode.InvalidParams, `Guardrail Block: Email contains sensitive credentials.`);
          }

          const result = await sendEmail(auth, args.to, args.subject, args.body);
          resultText = JSON.stringify(result, null, 2);
          break;
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }

      // Record successful audit log
      auditLogger.log({
        userId: user.id,
        role: user.role,
        toolName: name,
        parameters: (args as Record<string, unknown>) || {},
        status: 'SUCCESS',
        durationMs: Date.now() - startTime,
        ipAddress: clientIp,
      });

      return {
        content: [{ type: 'text', text: resultText }],
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      auditLogger.log({
        userId: user.id,
        role: user.role,
        toolName: name,
        parameters: (args as Record<string, unknown>) || {},
        status: 'ERROR',
        durationMs: Date.now() - startTime,
        errorMessage,
        ipAddress: clientIp,
      });

      if (err instanceof McpError) throw err;
      return {
        content: [{ type: 'text', text: `Tool error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Authentication middleware for API & SSE endpoints.
 */
function authenticateUser(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || '';
  const queryToken = (req.query.token as string) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || queryToken.trim();

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing API key. Provide via "Authorization: Bearer <key>" header or "?token=<key>" query param.',
    });
    return;
  }

  const user = vault.getUserByApiKey(token);
  if (!user) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key. Please check your team credentials.',
    });
    return;
  }

  (req as any).user = user;
  next();
}

// -------------------------------------------------------------
// REST API & MANAGEMENT ENDPOINTS
// -------------------------------------------------------------

// Health check endpoint for container orchestrators (K8s / Cloud Run)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds: Math.floor(process.uptime()),
    activeSessions: activeSessions.size,
    totalRegisteredUsers: vault.listUsers().length,
  });
});

// Admin endpoint: List team members
app.get('/api/users', authenticateUser, (req, res) => {
  const user = (req as any).user as TeamMember;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }

  res.json({ users: vault.listUsers() });
});

// Admin endpoint: Register new developer and issue team API key
app.post('/api/users', authenticateUser, (req, res) => {
  const user = (req as any).user as TeamMember;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }

  const { name, email, role } = req.body;
  if (!name || !email) {
    res.status(400).json({ error: '"name" and "email" are required.' });
    return;
  }

  const newMember = vault.registerUser(name, email, role || 'developer');
  res.status(201).json({
    message: 'Team member registered successfully.',
    user: {
      id: newMember.id,
      name: newMember.name,
      role: newMember.role,
      apiKey: newMember.apiKey,
    },
  });
});

// Admin endpoint: View tamper-evident audit logs
app.get('/api/audit', authenticateUser, (req, res) => {
  const user = (req as any).user as TeamMember;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }

  const limit = parseInt(req.query.limit as string) || 50;
  res.json({ logs: auditLogger.getRecent(limit) });
});

// -------------------------------------------------------------
// MCP REMOTE SSE STREAM ENDPOINT
// -------------------------------------------------------------

app.get('/sse', authenticateUser, async (req: Request, res: Response) => {
  const user = (req as any).user as TeamMember;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  // Verify user has authorized Google Workspace
  if (!vault.getGoogleTokens(user.id)) {
    res.status(400).json({
      error: 'Google Authorization Required',
      message: `User ${user.id} has not yet authorized Google Workspace.`,
      authUrl: `http://localhost:${PORT}/auth/google?userId=${encodeURIComponent(user.id)}`,
    });
    return;
  }

  console.log(`[MCP SSE] Client connected: ${user.name} (${user.id}) [Role: ${user.role}]`);

  // Create SSE transport directing messages to /messages
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServerForUser(user, clientIp);

  const sessionId = transport.sessionId;
  activeSessions.set(sessionId, { transport, server, user });

  transport.onclose = () => {
    console.log(`[MCP SSE] Session closed: ${sessionId} for ${user.id}`);
    activeSessions.delete(sessionId);
  };

  await server.connect(transport);
});

// MCP POST messages endpoint
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query parameter.' });
    return;
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }

  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP POST] Error processing message for session ${sessionId}:`, msg);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process message.', details: msg });
    }
  }
});

// -------------------------------------------------------------
// OAUTH WEB PORTAL FOR TEAM MEMBERS
// -------------------------------------------------------------

app.get('/auth/google', (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).send('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured on the server.');
    return;
  }

  const redirectUri = `http://localhost:${PORT}/auth/google/callback`;
  const oauthClient = new OAuth2Client(clientId, clientSecret, redirectUri);

  const state = req.query.userId ? String(req.query.userId) : '';
  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });

  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code) {
    res.status(400).send('Authorization code missing from Google callback.');
    return;
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = `http://localhost:${PORT}/auth/google/callback`;
    const oauthClient = new OAuth2Client(clientId, clientSecret, redirectUri);

    const { tokens } = await oauthClient.getToken(code);
    oauthClient.setCredentials(tokens);

    // Fetch user profile from Google to identify them
    const tokenInfo = await oauthClient.getTokenInfo(tokens.access_token!);
    const userEmail = tokenInfo.email || state || 'developer@team.local';

    // Register or retrieve user in vault
    const user = vault.registerUser(userEmail.split('@')[0], userEmail, 'developer');
    vault.saveGoogleTokens(user.id, tokens);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>OmniGraph — Enterprise Authorization Successful</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 520px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            h2 { color: #38bdf8; margin-top: 0; }
            .key-box { background: #0f172a; border: 1px dashed #64748b; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 14px; word-break: break-all; color: #4ade80; margin: 16px 0; }
            .hint { color: #94a3b8; font-size: 13px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Authorization Complete!</h2>
            <p>Your Google Workspace credentials have been encrypted and saved to the Enterprise Vault for <strong>${user.id}</strong>.</p>
            <p>Here is your personal Team API Key:</p>
            <div class="key-box">${user.apiKey}</div>
            <p class="hint">Use this key in your MCP Client (Claude Desktop, Cursor, or AI Agent) with the endpoint:<br/><code>http://localhost:${PORT}/sse?token=${user.apiKey}</code></p>
          </div>
        </body>
      </html>
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`Failed to complete OAuth exchange: ${msg}`);
  }
});

// Start the Enterprise Server
app.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🏢 [ENTERPRISE SERVER] OmniGraph Remote MCP is live!`);
  console.log(`   Port:           http://localhost:${PORT}`);
  console.log(`   SSE Endpoint:   http://localhost:${PORT}/sse`);
  console.log(`   Health Check:   http://localhost:${PORT}/health`);
  console.log(`   Team Web OAuth: http://localhost:${PORT}/auth/google`);
  console.log(`========================================================\n`);
});
