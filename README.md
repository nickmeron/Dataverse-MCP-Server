# dataverse-mcp-server

MCP server that gives Claude (or any MCP client) full access to Microsoft Dynamics 365 / Dataverse APIs.

99 tools + 20 skills covering metadata exploration, CRUD operations, plugin registration, solution ALM, security auditing, web resources, audit logs, managed identity, Power Automate cloud flows, and more.

---

## Features

| Category | Tools | Examples |
|----------|-------|---------|
| Auth | 2 | Sign in as yourself via `az login` (delegated, no secret) |
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
| Power Automate | 12 | Cloud flow CRUD, validate, on/off/restart, run history, cancel runs, connection references |
| PAC CLI | 4 skills | Auth, PCF component scaffolding, Plugin project scaffolding, Solution pack/unpack for CI/CD |

### Power Automate (cloud flows)

Cloud flows are Dataverse `workflow` rows (category 5) whose definition lives in `clientdata`; run
history is the `flowrun` table; connectors bind through `connectionreference` rows. The 12 tools use
the Dataverse Web API only — same token, no extra consent.

| Tool | Does |
|------|------|
| `list_cloud_flows` | Filter by name, On/Off, solution, flow type, the table that triggers them, or text in their definition |
| `get_cloud_flow` | Trigger summary, action outline, connection-reference health, solutions, latest runs, portal link, `version`, full definition, trigger registration |
| `validate_cloud_flow` | Dry-run lint against the environment (no write) |
| `create_cloud_flow` / `update_cloud_flow` | Validated create (in a solution) / replace; `expected_version` concurrency; managed flows refused by default |
| `set_cloud_flow_state` | On / off / restart, with the real cause of activation failures |
| `delete_cloud_flow` | Refuses managed flows and flows other flows call as a child, unless forced |
| `list_cloud_flow_runs` / `cancel_cloud_flow_runs` | Run history with errors and per-status counts; cancel in-progress runs |
| `list_connection_references` / `create_connection_reference` / `update_connection_reference` | Find, create, rebind (lists or restarts the active flows that keep the old connection) |

Behaviour the tools guard against, each reproduced against a live org:

- **Draft flows are not validated** — the Logic Apps template is checked only when a flow is turned on. The tools lint first and write nothing on error.
- **"On" is not "will fire"** — a Dataverse trigger with `filteringattributes` on a change type without *Modified* activates and never registers. The tools confirm the trigger's `callbackregistration` after every activation.
- **"Cannot find connection with name …"** means the connection is not shared with you, not that it is missing.
- **Table names differ** — the row trigger takes the logical name (`incident`), actions take the entity set name (`incidents`); both are resolved against org metadata.
- **Rebinding a connection reference does not reach active flows** until they are turned off and on.

---

## Prerequisites

- **Node.js** 18+
- **Azure CLI** (`az`) — used for delegated sign-in:
  - macOS: `brew install azure-cli` · Windows: `winget install --id Microsoft.AzureCLI` · Linux: `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`
- A **Dynamics 365 user account** with access to your environment(s) — your own Dataverse security roles govern what you can do (no app registration or client secret needed)
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

### 4. Sign in

Run `/mcp` in Claude Code — you should see `dynamics365 · ✓ connected`.

Then say:

> "Connect to Dataverse"

Claude calls `authenticate`, which uses your existing `az login` session — or runs `az login` for you (a browser opens; just pick your account). You sign in **as yourself**, so your creates/updates are attributed to the real you, not an app. **No client secret.**

---

## Authentication

Delegated — you sign in with your **own** Azure AD identity (via the Azure CLI), so Dataverse stamps `createdby` / `modifiedby` with the real human. **No client secret**, and access is governed by your own Dataverse security roles.

Say `"Connect to Dataverse"` and the server signs you in, in this order:

1. **Existing `az login` session** — used silently if present.
2. **Runs `az login` for you** — opens a browser; just pick your account. This is the browser-based auth-code flow, which Conditional Access allows.
3. **Azure CLI required** — if it isn't installed, `authenticate` returns one-line install instructions for your OS.

> **Device-code sign-in is opt-in only** (`authenticate` with `method: "device_code"`) and is frequently blocked by Conditional Access — the *"an authentication flow that is restricted by your admin"* page. The browser `az login` flow above is the supported path.

### Optional: pin a tenant

Set `D365_TENANT_ID` to sign in against a specific tenant (otherwise your `az` default tenant is used):

```bash
claude mcp add dynamics365 -t stdio \
  -e D365_TENANT_ID=your-tenant-id \
  -- node /full/path/to/dataverse-mcp-server/mcp-server/dist/index.js
```

### Grant yourself access

Assign your user a **Dataverse security role** in the target environment (Power Platform admin center → Environment → Users + permissions). No app registration or client secret is required.

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
| `bulk-delete` | Create, monitor and cancel bulk deletion jobs |
| `manage-power-automate` | Power Automate cloud flows — inspect, debug runs, author/edit/on-off/delete safely, connection references |

---

## Security

- **Delegated auth** — you sign in as yourself via `az login`; there is **no client secret** to store or leak
- Access is governed by your own Dynamics 365 security roles
- The server uses the OAuth 2.0 authorization-code flow via the Azure CLI (device-code is opt-in only)
- All tokens are cached **in memory only** and refreshed automatically from your `az` session
- See `.env.example` for the full list of supported variables

---

## License

MIT
