# OmniGraph — Enterprise Google Workspace MCP Platform

A production-grade, secure, multi-tenant Model Context Protocol (MCP) platform and Autonomous AI Agent exposing Google Workspace capabilities (Google Drive, Docs, and Gmail) to teams of developers.

Designed for **enterprise-grade security** with **zero paid services** (100% open-source and free).

---

## 🌟 Architecture & Capabilities

```text
               TEAM DEVELOPERS / AI CLIENTS (Claude Desktop, Cursor, Custom Agents)
                                         │
                         (Bearer API Key / SSE Transport)
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │       OmniGraph Enterprise HTTP/SSE Server     │
                 │                (Port: 3000)                   │
                 ├───────────────────────────────────────────────┤
                 │  • Multi-Tenant User Authentication           │
                 │  • Role-Based Access Control (admin/dev/ro)   │
                 │  • AES-256-GCM Zero-Cost Encrypted Vault      │
                 │  • Data Loss Prevention (DLP) Secret Scanner  │
                 │  • Outgoing Email Domain Whitelist Policy     │
                 │  • Tamper-Evident Immutable Audit Logger      │
                 └───────────────────────┬───────────────────────┘
                                         │ User Delegation
                                         ▼
                       ┌──────────────────────────────────┐
                       │  Google Workspace REST APIs      │
                       │  (Drive v3, Docs v1, Gmail v1)   │
                       └──────────────────────────────────┘
```

---

## 🛡️ Enterprise Security Features

1. **Multi-Tenant Token Vault (`src/security/vault.ts`)**:
   - Stores per-developer OAuth credentials encrypted at rest using **AES-256-GCM**.
   - No unencrypted plaintext tokens on disk.
   - Issues isolated bearer API keys for each developer (`omni_developer_...`).
2. **Role-Based Access Control (RBAC)**:
   - `admin`: Full management access, audit log viewing, team member registration.
   - `developer`: Access to Drive, Docs, and Gmail tools within policy boundaries.
   - `readonly`: Restricted to inspection tools (`search_drive`, `read_doc`, `read_recent_emails`). Cannot modify documents or send emails.
3. **Data Loss Prevention (DLP) & Secret Scanning (`src/security/guardrails.ts`)**:
   - Inspects generated documents and outgoing emails in real time.
   - Automatically blocks actions if private keys, API keys, AWS credentials, or bearer tokens are detected in the payload.
4. **Email Recipient Whitelist Policy**:
   - Configurable `ALLOWED_EMAIL_DOMAINS` in `.env` (e.g. `yourcompany.com`).
   - Prevents AI agents from sending emails outside permitted corporate domains.
5. **Immutable Structured Audit Logging (`src/security/audit.ts`)**:
   - Every tool call is logged with UUID, timestamp, user ID, role, tool name, parameters, execution duration, and client IP in `data/audit.log`.
6. **Web OAuth Onboarding Portal**:
   - Team members navigate to `http://localhost:3000/auth/google` in their browser to authorize their Google account and receive their team API key instantly.

---

## 🛠️ Exposed MCP Tools

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `search_drive` | `query` (string) | Searches Google Drive by keyword or Drive query syntax. |
| `read_doc` | `documentId` (string) | Extracts structured plain text from any Google Doc. |
| `create_doc` | `title` (string), `content` (string) | Creates a Google Doc, inserts text, and returns the link. (Guarded by DLP scanner). |
| `read_recent_emails` | `maxResults` (integer) | Fetches latest Gmail messages with subjects, senders, and decoded bodies. |
| `send_email` | `to` (string), `subject` (string), `body` (string) | Sends MIME email. (Guarded by domain whitelist & DLP scanner). |

---

## 🚀 Running the Platform

### Mode A: Remote Multi-User Enterprise Server (HTTP/SSE)

Start the centralized team server:

```powershell
npm run server:http
```

- **Health check**: `http://localhost:3000/health`
- **Developer OAuth Onboarding**: `http://localhost:3000/auth/google`
- **MCP SSE Endpoint**: `http://localhost:3000/sse?token=<DEVELOPER_API_KEY>`

#### Connecting Claude Desktop or Cursor to Remote Server

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "omnigraph-team": {
      "command": "node",
      "args": ["-e", "import('@modelcontextprotocol/sdk/client/sse.js').then(m => console.log('Connecting via SSE URL...'))"],
      "url": "http://localhost:3000/sse?token=YOUR_TEAM_API_KEY"
    }
  }
}
```

Or connect natively via any SSE-compatible MCP client using:
- **URL**: `http://localhost:3000/sse`
- **Headers**: `Authorization: Bearer YOUR_TEAM_API_KEY`

---

### Mode B: Local Single-User Stdio MCP Server

To run locally on a developer's machine over standard I/O:

```powershell
npm start
```

---

### Mode C: Autonomous AI Agent CLI

Launch the interactive AI Agent powered by Google Gemini:

```powershell
npm run agent
```

---

## 🐳 Docker Production Deployment (Free)

Deploy the containerized enterprise server using Docker:

```powershell
# Build and start in background
docker compose up -d --build

# View real-time logs
docker compose logs -f
```

The container runs as an unprivileged `node` user on Alpine Linux with built-in health checks and volume persistence for encrypted vault credentials in `./data`.

---

## 📁 Repository Structure

```text
OmniGraph/
├── Dockerfile                   # Multi-stage Alpine container build
├── docker-compose.yml           # Production container orchestration
├── .dockerignore                # Container build exclusions
├── .env                         # Server secrets & configuration
├── .env.example                 # Environment configuration template
├── package.json                 # Dependencies and npm scripts
├── tsconfig.json                # TypeScript ESM configuration
├── data/                        # Persistent encrypted vault & audit logs
│   ├── .key                     # 256-bit AES master encryption key
│   ├── vault.json               # Multi-tenant user credentials (encrypted)
│   └── audit.log                # Immutable JSONL compliance audit trail
├── src/
│   ├── server.ts                # Remote Enterprise HTTP/SSE MCP Server
│   ├── index.ts                 # Local stdio MCP Server entrypoint
│   ├── agent.ts                 # Autonomous AI Agent CLI (with retry & failover)
│   ├── auth.ts                  # OAuth2 client helpers & desktop authorization
│   ├── security/
│   │   ├── encryption.ts        # Zero-cost AES-256-GCM encryption engine
│   │   ├── vault.ts             # Multi-tenant token and user vault
│   │   ├── guardrails.ts        # DLP secret scanner, email whitelist, RBAC
│   │   └── audit.ts             # Structured audit logger for compliance
│   └── tools/
│       ├── drive.ts             # Drive v3 integration
│       ├── docs.ts              # Docs v1 integration
│       └── gmail.ts             # Gmail v1 integration
└── dist/                        # Compiled JavaScript production build
```
