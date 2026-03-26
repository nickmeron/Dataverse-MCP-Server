# dataverse-mcp-server

MCP server that gives Claude (or any MCP client) full access to Microsoft Dynamics 365 / Dataverse APIs.

68 tools + 18 skills covering metadata exploration, CRUD operations, plugin registration, solution ALM, security auditing, web resources, audit logs, managed identity, and more.

---

## Features

| Category | Tools | Examples |
|----------|-------|---------|
| Auth | 2 | Authenticate interactively or via env vars |
| Environment | 3 | Switch between Dev / Test / Prod at runtime |
| Metadata | 8 | Entities, fields, relationships, option sets, keys |
| Data (CRUD) | 8 | Query, create, update, delete, FetchXML, batch |
| Security | 8 | Users, roles, teams, queues, privilege comparison |
| Plugins | 21 | Assemblies, steps, images, SDK messages, enable/disable |
| Solutions | 4 | List, inspect components, dependencies |
| ALM | 3 | Export, import, publish customizations |
| Web Resources | 4 | List, read, create, update JS/HTML/CSS |
| Audit | 4 | Audit history, entity/field/org audit status |
| Custom Actions | 4 | Discover and inspect Custom Actions & APIs |
| Env Variables | 3 | List, get, set environment variables |
| Managed Identity | 4 | UAMI setup for plugin Azure access |
| Org Settings | 2 | Organization metadata, trace log control |
| Batch | 1 | Execute multiple API calls atomically |
| PAC CLI | 4 skills | Auth, PCF component scaffolding, Plugin project scaffolding, Solution pack/unpack for CI/CD |

---

## Prerequisites

- **Node.js** 18+
- **Azure AD App Registration** with:
  - `Dynamics CRM > user_impersonation` permission (or application-level access)
  - Client secret or certificate
- **Dynamics 365 environment URL(s)**

---

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/your-username/dataverse-mcp-server.git
cd dataverse-mcp-server/mcp-server
npm install
npm run build
```

### 2. Register with Claude Code

```bash
claude mcp add dynamics365 -t stdio \
  -- node /full/path/to/dataverse-mcp-server/mcp-server/dist/index.js
```

### 3. Install skills

**macOS / Linux:**
```bash
cp -r skills/* ~/.claude/skills/
```

**Windows:**
```bash
xcopy /E /I skills\* "%USERPROFILE%\.claude\skills\"
```

### 4. Authenticate

Run `/mcp` in Claude Code — you should see `dynamics365 · ✓ connected`.

Then say:

> "Connect to Dataverse"

Claude will call `auth_status`, see you're not authenticated, and ask for your **Tenant ID**, **Client ID**, and **Client Secret**. Credentials are held **in memory only** — never written to disk.

---

## Authentication

### Option A — Interactive (recommended for first-time setup)

Just open Claude Code and say `"Connect to Dataverse"`. Claude will call `auth_status`, see you're not authenticated, and ask for your credentials interactively.

Or provide them directly:
```
"Connect to Dataverse with tenant ID <id>, client ID <id>, and secret <secret>"
```

Credentials are held **in memory only** — never written to disk.

### Option B — Environment variables

```bash
claude mcp add dynamics365 -t stdio \
  -e D365_TENANT_ID=your-tenant-id \
  -e D365_CLIENT_ID=your-client-id \
  -e D365_CLIENT_SECRET=your-client-secret \
  -- node /full/path/to/dataverse-mcp-server/mcp-server/dist/index.js
```

### Get your Azure AD credentials

1. Go to [Azure Portal → App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Find or create an app registration with `Dynamics CRM > user_impersonation` permission
3. Copy the **Directory (tenant) ID** and **Application (client) ID** from the Overview page
4. Go to **Certificates & secrets** → **New client secret** → copy the **Value**

---

## Environment Configuration

Three ways to pre-configure your Dynamics 365 environments:

**Option A — Single URL** (auto-selected, simplest)

```bash
-e D365_ORG_URL=https://yourorg.crm.dynamics.com
```

**Option B — Comma-separated URLs** (names derived from hostname)

```bash
-e 'D365_ENVIRONMENTS=https://yourorg-dev.crm.dynamics.com,https://yourorg.crm.dynamics.com'
```

**Option C — JSON array** (full control over names)

```bash
-e 'D365_ENVIRONMENTS=[{"name":"Dev","url":"https://yourorg-dev.crm.dynamics.com"},{"name":"Prod","url":"https://yourorg.crm.dynamics.com"}]'
```

**Option D — Runtime** — no env vars needed. Just ask Claude:
> "connect to https://myorg.crm.dynamics.com"

and it calls `add_environment` for you.

### CRM Region Reference

| Suffix | Region |
|--------|--------|
| `.crm.dynamics.com` | Americas |
| `.crm4.dynamics.com` | EMEA |
| `.crm5.dynamics.com` | Asia Pacific |
| `.crm9.dynamics.com` | UK |
| `.crm11.dynamics.com` | Japan |

### Full settings.local.json example

```json
{
  "mcpServers": {
    "dynamics365": {
      "type": "stdio",
      "command": "node",
      "args": ["/full/path/to/dataverse-mcp-server/mcp-server/dist/index.js"],
      "env": {
        "D365_TENANT_ID": "your-tenant-id",
        "D365_CLIENT_ID": "your-client-id",
        "D365_CLIENT_SECRET": "your-client-secret",
        "D365_ORG_URL": "https://yourorg.crm.dynamics.com"
      }
    }
  }
}
```

---

## Skills

Skills are `SKILL.md` files that give Claude domain-specific guidance. See [Quick Start](#quick-start) for installation commands.

| Skill | Description |
|-------|-------------|
| `query-records` | Natural language → OData queries |
| `create-record` | Metadata-aware record creation |
| `summarize-entity` | Business-readable record summaries |
| `explore-metadata` | Deep entity introspection |
| `d365-research` | Microsoft Learn + live metadata research |
| `security-audit` | User and role investigation |
| `debug-plugin` | Plugin trace logs + Custom Action discovery |
| `inspect-solutions` | Solution component inspection |
| `manage-plugins` | Full Plugin Registration Tool workflow |
| `manage-webhooks` | Webhook and Service Bus endpoint management |
| `manage-webresources` | Web resource CRUD + publish |
| `alm-operations` | Solution export/import and environment variables |
| `audit-history` | Audit log queries and status checks |
| `managed-identity` | UAMI + federated credentials setup for plugins |
| `pac-auth` | PAC CLI authentication |
| `pac-pcf` | PCF component scaffolding |
| `pac-plugin` | Plugin project scaffolding |
| `pac-solutions` | Solution pack/unpack for CI/CD |

---

## Security

- **Never** hardcode credentials in source files
- **Never** commit `.env` files — they are in `.gitignore`
- Use Azure Key Vault or environment variables in production
- The MCP server uses OAuth 2.0 Client Credentials flow
- All tokens are cached **in memory only** and expire automatically
- See `.env.example` for the full list of supported variables

---

## License

MIT
