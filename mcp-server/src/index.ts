#!/usr/bin/env node
/**
 * Dynamics 365 MCP Server v6 — Full-Stack Dataverse Tooling + Plugin Registration
 *
 * Capabilities:
 *   - Multi-environment management (configurable via D365_ENVIRONMENTS env var)
 *   - Deep metadata exploration (entities, fields, relationships, option sets, keys)
 *   - CRUD + FetchXML + OData queries
 *   - Security & user management (users, roles, teams, queues, privilege comparison)
 *   - Custom Action & Custom API discovery
 *   - Plugin trace log retrieval for debugging
 *   - Solution management (list, inspect, dependencies)
 *   - Plugin Registration Tool (assemblies, types, steps, images, service endpoints)
 *   - SDK Message & Message Filter browsing
 *   - Organization settings (trace log toggle)
 *   - Batch operations
 *   - Power Automate cloud flows (CRUD, on/off, run history, connection references)
 *
 * Authentication (delegated — sign in as yourself, no client secret):
 *   Tokens are acquired as the signed-in user via your Azure CLI session. Run `az login`
 *   (or call the `authenticate` tool, which can run it for you), and your Dataverse writes
 *   are attributed to the real human, not an app registration.
 *
 * Optional env vars:
 *   D365_TENANT_ID        — Azure AD tenant (GUID) to sign in against; omit to use your az default
 *   D365_PUBLIC_CLIENT_ID — Public client ID for the opt-in device-code flow (defaults to Azure CLI client)
 *   D365_ORG_URL          — Single org URL (auto-selected, no need to call select_environment)
 *   D365_ENVIRONMENTS     — Multiple orgs. Accepts either:
 *                            JSON: [{"name":"Dev","url":"https://myorg-dev.crm.dynamics.com"}]
 *                            CSV:  https://myorg-dev.crm.dynamics.com,https://myorg.crm.dynamics.com
 *   D365_API_VERSION      — Defaults to 9.2
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AzureCliCredential, DeviceCodeCredential } from "@azure/identity";
import { spawn } from "child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

// Delegated auth: tokens are minted as the signed-in *user* (via the Azure CLI), never as an
// app — so Dataverse stamps createdby/modifiedby with the real human. No client secret.
let TENANT_ID = process.env.D365_TENANT_ID ?? "";   // optional: pin a tenant; else the az default is used

// Public client ID for the opt-in device-code flow. NOT a secret: the Azure CLI's well-known
// first-party client is a *public* client (allows device-code with zero app-registration setup).
// Override only with another *public* client via D365_PUBLIC_CLIENT_ID.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const PUBLIC_CLIENT_ID = process.env.D365_PUBLIC_CLIENT_ID || AZURE_CLI_CLIENT_ID;
const API_VERSION = process.env.D365_API_VERSION ?? "9.2";

interface D365Environment { name: string; url: string; }

/** Derive a friendly name from a Dataverse URL, e.g. "https://myorg-dev.crm4.dynamics.com" → "myorg-dev" */
function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname; // e.g. myorg-dev.crm4.dynamics.com
    return host.split(".")[0];          // e.g. myorg-dev
  } catch {
    return url;
  }
}

function loadEnvironments(): D365Environment[] {
  // Option 1: Single URL via D365_ORG_URL
  const singleUrl = process.env.D365_ORG_URL ?? "";
  if (singleUrl) {
    const url = singleUrl.replace(/\/$/, "");
    return [{ name: nameFromUrl(url), url }];
  }

  const raw = process.env.D365_ENVIRONMENTS ?? "";
  if (!raw) return [];

  // Option 2: JSON array — [{"name":"Dev","url":"https://..."}]
  if (raw.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as Array<{ name?: string; url: string }>;
      return parsed.map((e) => {
        const url = e.url.replace(/\/$/, "");
        return { name: e.name || nameFromUrl(url), url };
      });
    } catch { throw new Error("D365_ENVIRONMENTS JSON is invalid. Expected: [{\"name\":\"Dev\",\"url\":\"https://...\"}]"); }
  }

  // Option 3: Comma-separated URLs — "https://org-dev.crm.dynamics.com,https://org.crm.dynamics.com"
  return raw.split(",").map((u) => u.trim()).filter(Boolean).map((u) => {
    const url = u.replace(/\/$/, "");
    return { name: nameFromUrl(url), url };
  });
}

const ENVIRONMENTS = loadEnvironments();
let activeEnvironment: D365Environment | null = null;

// Auto-select if there's exactly one environment
if (ENVIRONMENTS.length === 1) activeEnvironment = ENVIRONMENTS[0];

function getBaseUrl(): string {
  if (!activeEnvironment) throw new Error("NO_ENVIRONMENT_SELECTED: Call list_environments then select_environment, or use add_environment to add one.");
  return `${activeEnvironment.url}/api/data/v${API_VERSION}`;
}

// ─── Delegated Auth ─────────────────────────────────────────────────────────
// Tokens are acquired as the signed-in *user* (Azure CLI session, or an opt-in device-code
// sign-in), never as an app — so Dataverse stamps createdby/modifiedby with the real human.

const tokenCache = new Map<string, { value: string; expiresAt: number }>();

// The credential that established the current session (CLI or device-code), reused for silent
// refresh so the identity never changes underneath the user mid-session.
let activeCredential: AzureCliCredential | DeviceCodeCredential | null = null;
let cliCredential: AzureCliCredential | null = null;
let deviceCredential: DeviceCodeCredential | null = null;

// Device-code state — surfaced through authenticate/auth_status, never stdout (the MCP channel).
let pendingDeviceCode: { verificationUri: string; userCode: string } | null = null;
let deviceLoginInFlight: Promise<void> | null = null;
let deviceLoginError: string | null = null;

/** The `az login` command for the configured tenant (tenant is optional for this generic server). */
function azLoginCmd(): string {
  return TENANT_ID ? `az login --tenant ${TENANT_ID}` : "az login";
}

function getCliCredential(): AzureCliCredential {
  return (cliCredential ??= new AzureCliCredential(TENANT_ID ? { tenantId: TENANT_ID } : {}));
}

function getDeviceCredential(): DeviceCodeCredential {
  return (deviceCredential ??= new DeviceCodeCredential({
    ...(TENANT_ID ? { tenantId: TENANT_ID } : {}),
    clientId: PUBLIC_CLIENT_ID,
    // Don't auto-prompt inside getToken() — interactive sign-in happens only via authenticate.
    disableAutomaticAuthentication: true,
    userPromptCallback: (info: { verificationUri: string; userCode: string; message: string }) => {
      pendingDeviceCode = { verificationUri: info.verificationUri, userCode: info.userCode };
    },
  }));
}

type AzLoginResult = { ok: true } | { ok: false; reason: "not_installed" | "timeout" | "failed"; message: string };

/** Run `az login` for the user (opens a browser; blocks until they finish). Cross-platform; never throws. */
function runAzLogin(timeoutMs = 180_000): Promise<AzLoginResult> {
  return new Promise((resolve) => {
    // shell:true resolves az/az.cmd via PATH on macOS and Windows. TENANT_ID is a GUID — no injection.
    const child = spawn(`${azLoginCmd()} --only-show-errors`, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, reason: "timeout", message: "timed out — no sign-in completed within 3 minutes." }); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, reason: "not_installed", message: "the Azure CLI (az) isn't installed or isn't on PATH." }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      // With shell:true a missing `az` exits 127 ("command not found" / "not recognized").
      const notInstalled = code === 127 || /not found|not recognized|no such file/i.test(stderr);
      const tail = stderr.trim().split("\n").slice(-2).join(" ");
      resolve({ ok: false, reason: notInstalled ? "not_installed" : "failed", message: tail || `az exited with code ${code}` });
    });
  });
}

/** Cross-platform Azure CLI install + sign-in instructions (tenant-aware). */
function azInstallHint(): string {
  return (
    "Install the Azure CLI, then sign in (a browser opens — pick your account):\n" +
    "  • macOS:   brew install azure-cli\n" +
    "  • Windows: winget install --id Microsoft.AzureCLI\n" +
    "  • Linux:   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash\n" +
    "  • then:    " + azLoginCmd()
  );
}

/**
 * Recognize an Entra Conditional Access / device-code-flow block and return actionable guidance.
 * The branded "You don't have access to this … an authentication flow that is restricted by your
 * admin" page is a CA block, NOT a credential problem — the user signed in fine. Many tenants block
 * the device-code flow by policy, so we steer them to the browser-based `az login` flow.
 */
function conditionalAccessHelp(message: string): string | null {
  const m = (message || "").toLowerCase();
  const blocked =
    m.includes("aadsts53003") ||            // access blocked by Conditional Access policies
    m.includes("aadsts7000218") ||          // public client flow not enabled on the app
    m.includes("conditional access") ||
    m.includes("authentication flow") ||
    m.includes("does not meet the criteria") ||
    m.includes("not have access to this");
  if (!blocked) return null;
  return (
    "Your sign-in succeeded, but a Conditional Access policy blocked this flow " +
    '("an authentication flow that is restricted by your admin"). Many tenants block the ' +
    "device-code flow by policy (it's a known phishing vector).\n\n" +
    "✅ Use the browser-based Azure CLI flow instead, which Conditional Access typically allows:\n" +
    azInstallHint() +
    "\nThen call auth_status (or just run any tool)."
  );
}

/** Best-effort identity (UPN/email) from a Dataverse access token, for display only. */
function identityFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return payload.upn || payload.preferred_username || payload.unique_name || payload.email || null;
  } catch { return null; }
}

/** Acquire a Dataverse token for orgUrl as the signed-in user. Silent — never prompts. */
async function getAccessToken(orgUrl: string): Promise<string> {
  const cached = tokenCache.get(orgUrl);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;

  const scope = `${orgUrl}/.default`;
  const cred = activeCredential ?? getCliCredential(); // fall back to an existing `az login` session
  let result: { token: string; expiresOnTimestamp: number } | null = null;
  try {
    result = await cred.getToken(scope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `NOT_AUTHENTICATED: couldn't get a Dataverse token as you. ` +
      `Run \`${azLoginCmd()}\` (or call authenticate), then retry. (${msg})`
    );
  }
  if (!result) throw new Error(`NOT_AUTHENTICATED: call authenticate to sign in, or run \`${azLoginCmd()}\`.`);
  activeCredential ??= cred; // remember the CLI credential if it worked implicitly
  tokenCache.set(orgUrl, { value: result.token, expiresAt: result.expiresOnTimestamp });
  return result.token;
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

async function d365(
  path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>
): Promise<unknown> {
  const baseUrl = getBaseUrl();
  const token = await getAccessToken(activeEnvironment!.url);
  const url = path.startsWith("http") ? path : `${baseUrl}/${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, "OData-MaxVersion": "4.0", "OData-Version": "4.0",
    Accept: "application/json", "Content-Type": "application/json",
    Prefer: "odata.include-annotations=*", ...extraHeaders,
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`D365 ${res.status}: ${await res.text()}`);
  if (res.status === 204) {
    const eid = res.headers.get("OData-EntityId") ?? "";
    const m = eid.match(/\(([^)]+)\)$/);
    return { success: true, ...(m ? { id: m[1] } : {}) };
  }
  return res.json();
}

/** Batch helper — sends multiple requests in one $batch call */
async function d365Batch(
  requests: Array<{ method: string; url: string; body?: unknown }>
): Promise<unknown[]> {
  const baseUrl = getBaseUrl();
  const token = await getAccessToken(activeEnvironment!.url);
  const batchId = `batch_${Date.now()}`;
  const changesetId = `changeset_${Date.now()}`;

  let batchBody = "";
  const hasWrites = requests.some((r) => r.method !== "GET");

  if (hasWrites) {
    batchBody += `--${batchId}\r\nContent-Type: multipart/mixed; boundary=${changesetId}\r\n\r\n`;
    requests.forEach((req, i) => {
      const fullUrl = req.url.startsWith("http") ? req.url : `${baseUrl}/${req.url}`;
      batchBody += `--${changesetId}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: ${i + 1}\r\n\r\n`;
      batchBody += `${req.method} ${fullUrl} HTTP/1.1\r\nContent-Type: application/json\r\nAccept: application/json\r\n\r\n`;
      if (req.body) batchBody += JSON.stringify(req.body);
      batchBody += "\r\n";
    });
    batchBody += `--${changesetId}--\r\n`;
    batchBody += `--${batchId}--\r\n`;
  } else {
    requests.forEach((req) => {
      const fullUrl = req.url.startsWith("http") ? req.url : `${baseUrl}/${req.url}`;
      batchBody += `--${batchId}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
      batchBody += `GET ${fullUrl} HTTP/1.1\r\nAccept: application/json\r\n\r\n`;
    });
    batchBody += `--${batchId}--\r\n`;
  }

  const res = await fetch(`${baseUrl}/$batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0", "OData-Version": "4.0",
      "Content-Type": `multipart/mixed; boundary=${batchId}`,
      Accept: "application/json",
    },
    body: batchBody,
  });

  if (!res.ok) throw new Error(`Batch error ${res.status}: ${await res.text()}`);
  const text = await res.text();
  // Parse batch response — extract JSON bodies from multipart response
  const jsonBodies: unknown[] = [];
  const parts = text.split(/--batchresponse_[a-f0-9-]+/);
  for (const part of parts) {
    const jsonMatch = part.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { jsonBodies.push(JSON.parse(jsonMatch[0])); } catch { /* skip non-JSON */ }
    }
  }
  return jsonBodies;
}

function requireEnv(): void {
  if (!activeEnvironment)
    throw new Error("NO_ENVIRONMENT_SELECTED: Call list_environments → ask user → select_environment first.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const tools: Tool[] = [
  // ───────────────────────────── AUTH ─────────────────────────────────────────
  {
    name: "authenticate",
    description: "Sign in as yourself (delegated auth) so your creates/updates are attributed to you, not an app. No client secret. Uses your existing `az login` session, otherwise runs `az login` for you (opens a browser — the Conditional-Access-friendly auth-code flow). The Azure CLI is required; if it isn't installed you'll get install instructions. Device-code sign-in is opt-in only (often blocked by Conditional Access).",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["auto", "cli", "az_login", "device_code"], description: "auto (default): existing az session → else run `az login` for you (browser); if the Azure CLI is missing, returns install steps. cli: existing az session only. az_login: run `az login` now (opens browser). device_code: device-code flow — opt-in only, often blocked by Conditional Access." },
        tenant_id: { type: "string", description: "Optional Azure AD tenant (GUID) to sign in against. Defaults to D365_TENANT_ID or your az default tenant." },
      },
    },
  },
  {
    name: "auth_status",
    description: "Check whether the server is authenticated and which environment is active.",
    inputSchema: { type: "object", properties: {} },
  },
  // ───────────────────────────── ENVIRONMENT ─────────────────────────────────
  {
    name: "list_environments",
    description: "List all D365 environments. Call authenticate first if not yet authenticated, then select_environment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "select_environment",
    description: "Set the active environment for this session.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact name from list_environments" } },
      required: ["name"],
    },
  },
  {
    name: "add_environment",
    description: "Add a Dataverse environment at runtime. Useful when the user provides a URL during the conversation. Optionally auto-select it.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Dataverse org URL, e.g. https://myorg.crm.dynamics.com" },
        name: { type: "string", description: "Friendly name (optional — auto-derived from URL if omitted)" },
        select: { type: "boolean", description: "Immediately select this environment (default: true)" },
      },
      required: ["url"],
    },
  },

  // ───────────────────────────── METADATA ────────────────────────────────────
  {
    name: "list_entities",
    description: "List all entities in the environment. Returns LogicalName, DisplayName, EntitySetName, IsCustomEntity.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by logical name (e.g. 'account', 'new_')" },
        custom_only: { type: "boolean" },
      },
    },
  },
  {
    name: "get_entity_details",
    description: "Get basic entity info: LogicalName, DisplayName, EntitySetName, PrimaryIdAttribute, PrimaryNameAttribute.",
    inputSchema: {
      type: "object",
      properties: { entity_logical_name: { type: "string" } },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_entity_attributes",
    description: "Get all fields of an entity with types, display names, required level, custom flag. Resolves Picklist/Status/State option values inline.",
    inputSchema: {
      type: "object",
      properties: {
        entity_logical_name: { type: "string" },
        include_option_sets: { type: "boolean", description: "Default true. Set false to skip option set resolution." },
      },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_entity_relationships",
    description: "Get all relationships: 1:N, N:1, N:N. Returns schema names, referenced/referencing entities.",
    inputSchema: {
      type: "object",
      properties: {
        entity_logical_name: { type: "string" },
        type: { type: "string", description: "'OneToMany', 'ManyToOne', 'ManyToMany', or omit for all" },
      },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_entity_keys",
    description: "Get alternate keys for an entity.",
    inputSchema: {
      type: "object",
      properties: { entity_logical_name: { type: "string" } },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_picklist_options",
    description: "Get option values for a Picklist/Status/State field.",
    inputSchema: {
      type: "object",
      properties: {
        entity_logical_name: { type: "string" },
        attribute_logical_name: { type: "string" },
      },
      required: ["entity_logical_name", "attribute_logical_name"],
    },
  },
  {
    name: "get_global_option_sets",
    description: "List all global option sets.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string" } },
    },
  },
  {
    name: "get_global_option_set_details",
    description: "Get full details of a global option set including all values.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },

  // ───────────────────────────── DATA OPERATIONS ─────────────────────────────
  {
    name: "query_records",
    description: "Query records with OData. Supports $select, $filter, $orderby, $top, $expand, $count.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Plural name (e.g. 'accounts')" },
        select: { type: "string" }, filter: { type: "string" }, orderby: { type: "string" },
        top: { type: "number" }, expand: { type: "string" }, count: { type: "boolean" },
      },
      required: ["entity"],
    },
  },
  {
    name: "get_record",
    description: "Get a single record by GUID.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, id: { type: "string" }, select: { type: "string" }, expand: { type: "string" } },
      required: ["entity", "id"],
    },
  },
  {
    name: "create_record",
    description: "Create a new record.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, data: { type: "object", additionalProperties: true } },
      required: ["entity", "data"],
    },
  },
  {
    name: "update_record",
    description: "Update fields on an existing record.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, id: { type: "string" }, data: { type: "object", additionalProperties: true } },
      required: ["entity", "id", "data"],
    },
  },
  {
    name: "delete_record",
    description: "Delete a record.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, id: { type: "string" } },
      required: ["entity", "id"],
    },
  },
  {
    name: "execute_fetchxml",
    description: "Run a FetchXML query (aggregates, linked entities, complex conditions).",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, fetchxml: { type: "string" } },
      required: ["entity", "fetchxml"],
    },
  },
  {
    name: "execute_action",
    description: "Execute a bound or unbound Action/Function.",
    inputSchema: {
      type: "object",
      properties: {
        action_name: { type: "string" }, parameters: { type: "object", additionalProperties: true },
        entity: { type: "string" }, entity_id: { type: "string" },
      },
      required: ["action_name"],
    },
  },
  {
    name: "associate_records",
    description: "Create a relationship between two records.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" }, id: { type: "string" }, relationship: { type: "string" },
        related_entity: { type: "string" }, related_id: { type: "string" },
      },
      required: ["entity", "id", "relationship", "related_entity", "related_id"],
    },
  },

  // ──────────────────────── BULK DELETE OPERATIONS ──────────────────────────
  {
    name: "create_bulk_delete_job",
    description: "Create a bulk deletion job to asynchronously delete records matching a query. Returns a JobId (asyncoperationid) that can be monitored with get_bulk_delete_job.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string", description: "Display name for the bulk delete job" },
        entity: { type: "string", description: "Entity logical name to delete from (e.g. 'knowledgearticle', 'task')" },
        filter_conditions: {
          type: "array",
          description: "Optional QueryExpression conditions. If omitted, ALL records of the entity are targeted.",
          items: {
            type: "object",
            properties: {
              attribute: { type: "string", description: "Attribute logical name (e.g. 'statuscode')" },
              operator: { type: "string", description: "Condition operator: Equal, NotEqual, NotNull, Null, Like, In, GreaterThan, LessThan, OlderThanXDays, etc." },
              values: { type: "array", items: { type: "string" }, description: "Values for the condition (omit for Null/NotNull)" },
            },
            required: ["attribute", "operator"],
          },
        },
        start_datetime: { type: "string", description: "ISO 8601 start time (default: now)" },
        recurrence_pattern: { type: "string", description: "Recurrence rule string (empty for one-time run)" },
        send_email_notification: { type: "boolean", description: "Send email on completion (default false)" },
      },
      required: ["job_name", "entity"],
    },
  },
  {
    name: "list_bulk_delete_jobs",
    description: "List bulk deletion jobs. Filter by status to monitor running or completed jobs.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: waiting, running, completed, failed, cancelled. Omit for all." },
        top: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "get_bulk_delete_job",
    description: "Get the status and progress of a specific bulk deletion job by its JobId (asyncoperationid).",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The asyncoperationid (JobId) returned by create_bulk_delete_job" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "cancel_bulk_delete_job",
    description: "Cancel a bulk deletion job that is waiting or running. This deletes the async operation record.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The asyncoperationid (JobId) to cancel" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "get_bulk_delete_failures",
    description: "Get the list of records that failed to be deleted in a bulk delete job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The asyncoperationid (JobId)" },
        top: { type: "number", description: "Max failure records to return (default 50)" },
      },
      required: ["job_id"],
    },
  },

  // ───────────────────────────── SECURITY & USERS ────────────────────────────
  {
    name: "get_current_user",
    description: "Get the current authenticated user (the service principal) and the business unit it belongs to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_users",
    description: "Search for users by name, email, or keyword. Returns user ID, full name, email, business unit, and enabled state.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Search term (matches fullname, internalemailaddress, domainname)" },
        top: { type: "number", description: "Max results (default 20)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_user_roles",
    description: "Get all security roles assigned to a specific user.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string", description: "SystemUser GUID" } },
      required: ["user_id"],
    },
  },
  {
    name: "get_user_teams",
    description: "Get all teams a user belongs to.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string", description: "SystemUser GUID" } },
      required: ["user_id"],
    },
  },
  {
    name: "get_user_queues",
    description: "Get all queues assigned to a user.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string", description: "SystemUser GUID" } },
      required: ["user_id"],
    },
  },
  {
    name: "list_security_roles",
    description: "List all security roles in the environment.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by role name" },
      },
    },
  },
  {
    name: "get_role_privileges",
    description: "Get all privileges for a specific security role — shows entity access levels (Create, Read, Write, Delete, etc.).",
    inputSchema: {
      type: "object",
      properties: { role_id: { type: "string", description: "Role GUID" } },
      required: ["role_id"],
    },
  },
  {
    name: "compare_role_privileges",
    description: "Compare privileges between two security roles. Returns differences showing where access levels differ.",
    inputSchema: {
      type: "object",
      properties: {
        role_id_1: { type: "string", description: "First role GUID" },
        role_id_2: { type: "string", description: "Second role GUID" },
        role_name_1: { type: "string", description: "First role name (for display)" },
        role_name_2: { type: "string", description: "Second role name (for display)" },
      },
      required: ["role_id_1", "role_id_2"],
    },
  },

  // ───────────────────────────── CUSTOM ACTIONS & APIS ───────────────────────
  {
    name: "find_custom_actions",
    description: "Search for custom actions (workflows of type 'Action') by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Search term to match against action name" },
        top: { type: "number" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_custom_action_metadata",
    description: "Get metadata for a custom action — input/output parameters, bound entity, and how to call it via Web API.",
    inputSchema: {
      type: "object",
      properties: {
        action_name: { type: "string", description: "Unique name of the action (e.g. 'new_MyAction')" },
      },
      required: ["action_name"],
    },
  },
  {
    name: "find_custom_apis",
    description: "Search for Custom APIs by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Search term" },
        top: { type: "number" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_custom_api_metadata",
    description: "Get metadata for a Custom API — request parameters, response properties, bound entity, plugin type, and Web API invocation pattern.",
    inputSchema: {
      type: "object",
      properties: {
        unique_name: { type: "string", description: "Unique name of the Custom API" },
      },
      required: ["unique_name"],
    },
  },

  // ───────────────────────────── PLUGIN TRACE LOGS ───────────────────────────
  {
    name: "get_plugin_traces",
    description: "Get plugin trace logs for debugging. Filter by plugin type name, correlation ID, or message name. Returns execution time, depth, exceptions, and message blocks.",
    inputSchema: {
      type: "object",
      properties: {
        plugin_type_name: { type: "string", description: "Plugin type name to filter by (e.g. 'MyPlugin')" },
        correlation_id: { type: "string", description: "Correlation ID to filter by" },
        message_name: { type: "string", description: "SDK message name to filter by (e.g. 'Create', 'Update')" },
        top: { type: "number", description: "Max records (default 20)" },
        hours_back: { type: "number", description: "Only fetch logs from the last N hours (default 24)" },
      },
    },
  },

  // ───────────────────────────── SOLUTION MANAGEMENT ─────────────────────────
  {
    name: "list_solutions",
    description: "List all solutions in the environment. Returns solution name, display name, version, publisher, managed/unmanaged status, and install date.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by solution name or display name" },
        unmanaged_only: { type: "boolean", description: "If true, return only unmanaged solutions" },
      },
    },
  },
  {
    name: "get_solution_details",
    description: "Get detailed info about a specific solution including its publisher and version.",
    inputSchema: {
      type: "object",
      properties: {
        solution_unique_name: { type: "string", description: "Unique name (e.g. 'MyCustomizations')" },
      },
      required: ["solution_unique_name"],
    },
  },
  {
    name: "get_solution_components",
    description: "List all components (entities, option sets, web resources, workflows, plugins, etc.) in a solution.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "Solution GUID (from list_solutions)" },
        component_type: { type: "number", description: "Filter by component type. Common: 1=Entity, 2=Attribute, 9=OptionSet, 26=View, 29=Workflow, 61=WebResource, 91=PluginAssembly, 92=PluginType" },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "get_solution_dependencies",
    description: "Get dependencies for a solution — what other solutions or components this solution depends on.",
    inputSchema: {
      type: "object",
      properties: {
        solution_unique_name: { type: "string", description: "Unique name of the solution" },
      },
      required: ["solution_unique_name"],
    },
  },

  // ═════════════════════════════════════════════════════════════════════════════
  // NEW IN v5: PLUGIN REGISTRATION TOOL
  // ═════════════════════════════════════════════════════════════════════════════

  // ───────────────────────────── PLUGIN ASSEMBLIES ───────────────────────────
  {
    name: "list_plugin_assemblies",
    description: "List all registered plugin assemblies. Shows assembly name, version, culture, public key token, isolation mode, and source type.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by assembly name" },
        custom_only: { type: "boolean", description: "Exclude Microsoft/System assemblies (default true)" },
      },
    },
  },
  {
    name: "get_plugin_assembly_details",
    description: "Get full details of a plugin assembly including all its plugin types (classes).",
    inputSchema: {
      type: "object",
      properties: {
        assembly_id: { type: "string", description: "PluginAssembly GUID" },
      },
      required: ["assembly_id"],
    },
  },

  // ───────────────────────────── PLUGIN TYPES ────────────────────────────────
  {
    name: "list_plugin_types",
    description: "List plugin types (classes) in an assembly. Shows type name, friendly name, workflow activity group name.",
    inputSchema: {
      type: "object",
      properties: {
        assembly_id: { type: "string", description: "PluginAssembly GUID — lists types in this assembly" },
        filter: { type: "string", description: "Filter by type name (e.g. 'PreCreate', 'PostUpdate')" },
      },
    },
  },

  // ───────────────────────────── SDK MESSAGES ────────────────────────────────
  {
    name: "list_sdk_messages",
    description: "List available SDK messages (Create, Update, Delete, Associate, etc.). Needed to get message IDs when registering steps.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by message name (e.g. 'Create', 'Update')" },
        top: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "list_sdk_message_filters",
    description: "List SDK message filters — which entities a message applies to. Returns message filter ID, primary entity, and secondary entity. Needed for step registration.",
    inputSchema: {
      type: "object",
      properties: {
        message_name: { type: "string", description: "SDK message name (e.g. 'Create')" },
        entity_logical_name: { type: "string", description: "Primary entity logical name (e.g. 'account')" },
      },
    },
  },

  // ───────────────────────────── PROCESSING STEPS ────────────────────────────
  {
    name: "list_processing_steps",
    description: "List SDK message processing steps. Shows step name, message, entity, stage, mode, rank, status. Can filter by plugin type or assembly.",
    inputSchema: {
      type: "object",
      properties: {
        plugin_type_id: { type: "string", description: "Filter by plugin type GUID" },
        assembly_name: { type: "string", description: "Filter by assembly name (contains match)" },
        message_name: { type: "string", description: "Filter by SDK message name" },
        top: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "get_processing_step_details",
    description: "Get full details of a processing step including its plugin type, message, filter, images, and configuration.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
      },
      required: ["step_id"],
    },
  },
  {
    name: "register_processing_step",
    description: "Register a new SDK message processing step. Links a plugin type to an SDK message + entity at a specific pipeline stage. Stage: 10=PreValidation, 20=PreOperation, 40=PostOperation. Mode: 0=Synchronous, 1=Asynchronous.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Step name (e.g. 'MyPlugin: Create of account')" },
        plugin_type_id: { type: "string", description: "PluginType GUID" },
        sdk_message_id: { type: "string", description: "SdkMessage GUID (get from list_sdk_messages)" },
        sdk_message_filter_id: { type: "string", description: "SdkMessageFilter GUID (get from list_sdk_message_filters)" },
        stage: { type: "number", description: "Pipeline stage: 10=PreValidation, 20=PreOperation, 40=PostOperation" },
        mode: { type: "number", description: "Execution mode: 0=Synchronous, 1=Asynchronous" },
        rank: { type: "number", description: "Execution order (default 1)" },
        filtering_attributes: { type: "string", description: "Comma-separated attribute names to trigger on (for Update message)" },
        configuration: { type: "string", description: "Unsecure configuration string passed to plugin" },
        impersonating_user_id: { type: "string", description: "SystemUser GUID to impersonate" },
        async_auto_delete: { type: "boolean", description: "Auto-delete async job on success (default false)" },
        description: { type: "string" },
      },
      required: ["name", "plugin_type_id", "sdk_message_id", "stage", "mode"],
    },
  },
  {
    name: "update_processing_step",
    description: "Update an existing processing step. Supply only the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
        name: { type: "string" },
        stage: { type: "number", description: "10=PreValidation, 20=PreOperation, 40=PostOperation" },
        mode: { type: "number", description: "0=Synchronous, 1=Asynchronous" },
        rank: { type: "number" },
        filtering_attributes: { type: "string" },
        configuration: { type: "string" },
        impersonating_user_id: { type: "string" },
        async_auto_delete: { type: "boolean" },
        description: { type: "string" },
      },
      required: ["step_id"],
    },
  },
  {
    name: "toggle_processing_step",
    description: "Enable or disable a processing step. Enabled: statecode=0. Disabled: statecode=1.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
        enable: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["step_id", "enable"],
    },
  },
  {
    name: "delete_processing_step",
    description: "Delete a processing step registration. WARNING: This is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
      },
      required: ["step_id"],
    },
  },

  // ───────────────────────────── STEP IMAGES ─────────────────────────────────
  {
    name: "list_step_images",
    description: "List pre/post images registered on a processing step.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
      },
      required: ["step_id"],
    },
  },
  {
    name: "register_step_image",
    description: "Register a pre or post entity image on a processing step. Image type: 0=PreImage, 1=PostImage, 2=Both.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string", description: "SdkMessageProcessingStep GUID" },
        name: { type: "string", description: "Image name (e.g. 'PreImage', 'PostImage')" },
        entity_alias: { type: "string", description: "Alias to access the image in plugin code (e.g. 'PreImage')" },
        image_type: { type: "number", description: "0=PreImage, 1=PostImage, 2=Both" },
        attributes: { type: "string", description: "Comma-separated attribute names to include in the image (empty = all)" },
        message_property_name: { type: "string", description: "Message property: 'Target' for most messages, 'Id' for Delete" },
      },
      required: ["step_id", "name", "entity_alias", "image_type"],
    },
  },
  {
    name: "update_step_image",
    description: "Update an existing step image.",
    inputSchema: {
      type: "object",
      properties: {
        image_id: { type: "string", description: "SdkMessageProcessingStepImage GUID" },
        name: { type: "string" },
        entity_alias: { type: "string" },
        image_type: { type: "number", description: "0=PreImage, 1=PostImage, 2=Both" },
        attributes: { type: "string" },
      },
      required: ["image_id"],
    },
  },
  {
    name: "delete_step_image",
    description: "Delete a step image registration.",
    inputSchema: {
      type: "object",
      properties: {
        image_id: { type: "string", description: "SdkMessageProcessingStepImage GUID" },
      },
      required: ["image_id"],
    },
  },

  // ───────────────────────────── SERVICE ENDPOINTS & WEBHOOKS ─────────────────
  {
    name: "list_service_endpoints",
    description: "List all registered service endpoints (webhooks, Service Bus queues/topics, Event Hubs). Shows name, URL, contract type, auth type.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by name" },
        contract_type: { type: "number", description: "Filter by contract: 1=Queue, 2=Topic, 3=OneWay, 4=TwoWay, 5=REST, 7=EventHub, 8=Webhook" },
      },
    },
  },
  {
    name: "get_service_endpoint_details",
    description: "Get full details of a service endpoint including its registered steps.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: { type: "string", description: "ServiceEndpoint GUID" },
      },
      required: ["endpoint_id"],
    },
  },
  {
    name: "register_webhook",
    description: "Register a new webhook endpoint. Creates a ServiceEndpoint with contract=Webhook and optional step registration.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Webhook name" },
        url: { type: "string", description: "Webhook URL to POST to" },
        auth_type: { type: "number", description: "4=HttpHeader, 5=WebhookKey, 6=HttpQueryString" },
        auth_value: { type: "string", description: "Auth header/key/query value" },
        message_format: { type: "number", description: "Message format: 1=BinaryXML, 2=Json, 3=TextXML (default 2)" },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "register_service_bus_endpoint",
    description: "Register a Service Bus endpoint (queue, topic, or Event Hub).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Endpoint name" },
        namespace_address: { type: "string", description: "Service Bus namespace URL (e.g. 'sb://mynamespace.servicebus.windows.net')" },
        sas_key_name: { type: "string", description: "SAS key name" },
        sas_key: { type: "string", description: "SAS key value" },
        contract_type: { type: "number", description: "1=Queue, 2=Topic, 7=EventHub" },
        path: { type: "string", description: "Queue/Topic/EventHub name (path)" },
        message_format: { type: "number", description: "1=BinaryXML, 2=Json, 3=TextXML (default 2)" },
      },
      required: ["name", "namespace_address", "sas_key_name", "sas_key", "contract_type", "path"],
    },
  },
  {
    name: "update_service_endpoint",
    description: "Update an existing service endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: { type: "string", description: "ServiceEndpoint GUID" },
        name: { type: "string" },
        url: { type: "string" },
        auth_type: { type: "number" },
        auth_value: { type: "string" },
        message_format: { type: "number" },
      },
      required: ["endpoint_id"],
    },
  },
  {
    name: "delete_service_endpoint",
    description: "Delete a service endpoint registration. WARNING: Also deletes all steps registered against it.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_id: { type: "string", description: "ServiceEndpoint GUID" },
      },
      required: ["endpoint_id"],
    },
  },

  // ───────────────────────────── ORGANIZATION SETTINGS ───────────────────────
  {
    name: "get_org_settings",
    description: "Get organization settings including plugin trace log level, version, and org name.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_plugin_trace_setting",
    description: "Change the organization-level plugin trace log setting. 0=Off, 1=Exception, 2=All.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", description: "Trace level: 0=Off, 1=Exception, 2=All" },
      },
      required: ["level"],
    },
  },

  // ───────────────────────────── WEB RESOURCES ─────────────────────────────
  {
    name: "list_web_resources",
    description: "List web resources in the environment. Filter by name, type, or solution.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by name (contains match)" },
        type: { type: "number", description: "Filter by type: 1=HTML, 2=CSS, 3=JS, 4=XML, 5=PNG, 6=JPG, 7=GIF, 8=XAP, 9=XSL, 10=ICO, 11=SVG, 12=RESX" },
        top: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "get_web_resource",
    description: "Download/view a web resource. Returns the decoded content (for text types) or base64 content (for binary types).",
    inputSchema: {
      type: "object",
      properties: {
        web_resource_id: { type: "string", description: "WebResource GUID" },
      },
      required: ["web_resource_id"],
    },
  },
  {
    name: "update_web_resource",
    description: "Update a web resource's content. Provide the content as a string (will be base64 encoded automatically for text types).",
    inputSchema: {
      type: "object",
      properties: {
        web_resource_id: { type: "string", description: "WebResource GUID" },
        content: { type: "string", description: "The new content (plain text for JS/HTML/CSS/XML, base64 for binary)" },
        display_name: { type: "string", description: "Optional new display name" },
        description: { type: "string", description: "Optional new description" },
      },
      required: ["web_resource_id", "content"],
    },
  },
  {
    name: "create_web_resource",
    description: "Create a new web resource. Content will be base64 encoded automatically for text types.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name with prefix (e.g. 'new_/scripts/myfile.js')" },
        display_name: { type: "string", description: "Display name" },
        content: { type: "string", description: "The content (plain text for JS/HTML/CSS/XML)" },
        type: { type: "number", description: "Type: 1=HTML, 2=CSS, 3=JS, 4=XML, 5=PNG, 6=JPG, 7=GIF, 8=XAP, 9=XSL, 10=ICO, 11=SVG, 12=RESX" },
        description: { type: "string" },
        solution_unique_name: { type: "string", description: "Add to this solution (optional)" },
      },
      required: ["name", "content", "type"],
    },
  },

  // ───────────────────────────── ALM OPERATIONS ──────────────────────────────
  {
    name: "publish_customizations",
    description: "Publish all customizations or specific components. Use after updating web resources, forms, views, etc.",
    inputSchema: {
      type: "object",
      properties: {
        publish_all: { type: "boolean", description: "If true, publishes ALL customizations (default). If false, provide component_xml." },
        component_xml: { type: "string", description: "XML string specifying which components to publish (ParameterXml format)" },
      },
    },
  },
  {
    name: "export_solution",
    description: "Export a solution as a zip file (base64 encoded). Can export as managed or unmanaged.",
    inputSchema: {
      type: "object",
      properties: {
        solution_unique_name: { type: "string", description: "Unique name of the solution to export" },
        managed: { type: "boolean", description: "Export as managed (true) or unmanaged (false, default)" },
      },
      required: ["solution_unique_name"],
    },
  },
  {
    name: "import_solution",
    description: "Import a solution zip file (base64 encoded). Can overwrite existing customizations.",
    inputSchema: {
      type: "object",
      properties: {
        solution_file_base64: { type: "string", description: "Base64 encoded solution zip file content" },
        overwrite_unmanaged: { type: "boolean", description: "Overwrite unmanaged customizations (default true)" },
        publish_workflows: { type: "boolean", description: "Activate workflows after import (default true)" },
      },
      required: ["solution_file_base64"],
    },
  },

  // ───────────────────────────── ENVIRONMENT VARIABLES ───────────────────────
  {
    name: "list_environment_variables",
    description: "List environment variable definitions and their current values.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by schema name or display name" },
      },
    },
  },
  {
    name: "get_environment_variable",
    description: "Get a specific environment variable's definition and current value.",
    inputSchema: {
      type: "object",
      properties: {
        schema_name: { type: "string", description: "Schema name of the environment variable (e.g. 'cr123_MyApiKey')" },
      },
      required: ["schema_name"],
    },
  },
  {
    name: "set_environment_variable",
    description: "Set the value of an environment variable. Creates or updates the EnvironmentVariableValue record.",
    inputSchema: {
      type: "object",
      properties: {
        definition_id: { type: "string", description: "EnvironmentVariableDefinition GUID" },
        value: { type: "string", description: "The new value to set" },
      },
      required: ["definition_id", "value"],
    },
  },

  // ───────────────────────────── ROLE ASSIGNMENT ─────────────────────────────
  {
    name: "assign_security_role",
    description: "Assign a security role to a user.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "SystemUser GUID" },
        role_id: { type: "string", description: "Security Role GUID" },
      },
      required: ["user_id", "role_id"],
    },
  },
  {
    name: "remove_security_role",
    description: "Remove a security role from a user.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "SystemUser GUID" },
        role_id: { type: "string", description: "Security Role GUID" },
      },
      required: ["user_id", "role_id"],
    },
  },

  // ───────────────────────────── AUDIT HISTORY ────────────────────────────────
  {
    name: "get_audit_history",
    description: "Query audit history records. Filter by entity, record ID, user, action (Create/Update/Delete), date range, or changed attributes. Shows who changed what, when, old values, and new values.",
    inputSchema: {
      type: "object",
      properties: {
        record_id: { type: "string", description: "GUID of the specific record to get audit history for" },
        entity_logical_name: { type: "string", description: "Entity logical name (e.g. 'account'). Required with record_id." },
        user_id: { type: "string", description: "Filter by user who made the change (SystemUser GUID)" },
        action: { type: "number", description: "Filter by action: 1=Create, 2=Update, 3=Delete, 12=Upsert" },
        top: { type: "number", description: "Max records (default 50)" },
        hours_back: { type: "number", description: "Only return audit records from the last N hours" },
        attribute_filter: { type: "string", description: "Comma-separated attribute names — only return audits where these fields changed" },
      },
    },
  },
  {
    name: "get_entity_audit_status",
    description: "Check if auditing is enabled on a specific entity. Uses entity metadata to read IsAuditEnabled flag.",
    inputSchema: {
      type: "object",
      properties: {
        entity_logical_name: { type: "string", description: "Entity logical name (e.g. 'account')" },
      },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_field_audit_status",
    description: "Check which fields on an entity have auditing enabled. Returns each attribute's IsAuditEnabled flag.",
    inputSchema: {
      type: "object",
      properties: {
        entity_logical_name: { type: "string", description: "Entity logical name (e.g. 'account')" },
        fields: { type: "string", description: "Comma-separated field names to check (omit for all fields)" },
      },
      required: ["entity_logical_name"],
    },
  },
  {
    name: "get_org_audit_status",
    description: "Check if auditing is enabled at the organization level and get audit retention settings.",
    inputSchema: { type: "object", properties: {} },
  },

  // ───────────────────────────── MANAGED IDENTITY ─────────────────────────────
  {
    name: "list_managed_identities",
    description: "List all managed identity records registered in Dataverse. Shows application ID, tenant ID, credential source, and subject scope.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by application ID" },
      },
    },
  },
  {
    name: "create_managed_identity",
    description: "Register a managed identity record in Dataverse. Links a User-Assigned Managed Identity (UAMI) to the environment for plugin token acquisition.",
    inputSchema: {
      type: "object",
      properties: {
        application_id: { type: "string", description: "UAMI Client ID (Application ID) from Azure" },
        managed_identity_id: { type: "string", description: "GUID for the managed identity record. Use the SAME GUID across all environments for solution promotion." },
        tenant_id: { type: "string", description: "Azure AD Tenant ID" },
        credential_source: { type: "number", description: "2 = Federated (UAMI). Default 2." },
        subject_scope: { type: "number", description: "1 = Environment. Default 1." },
      },
      required: ["application_id", "managed_identity_id", "tenant_id"],
    },
  },
  {
    name: "associate_assembly_managed_identity",
    description: "Associate a plugin assembly with a managed identity record. After this, plugins in the assembly can call IManagedIdentityService.AcquireToken().",
    inputSchema: {
      type: "object",
      properties: {
        assembly_id: { type: "string", description: "PluginAssembly GUID" },
        managed_identity_id: { type: "string", description: "ManagedIdentity GUID (from create_managed_identity)" },
      },
      required: ["assembly_id", "managed_identity_id"],
    },
  },
  {
    name: "compute_federated_credential_subject",
    description: "Compute the federated identity credential subject string for a Dataverse environment. Returns the exact 'subject' value needed when creating the federated credential on the UAMI in Azure.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Azure AD Tenant ID (GUID)" },
        application_id: { type: "string", description: "Service principal / app registration Client ID used by Dataverse (GUID)" },
        environment_id: { type: "string", description: "Dataverse environment/organization ID (GUID)" },
        cert_hash_hex: { type: "string", description: "SHA-256 hash of the signing certificate in HEX format (lowercase, no separators)" },
      },
      required: ["tenant_id", "application_id", "environment_id", "cert_hash_hex"],
    },
  },

  // ───────────────────────────── BATCH OPERATIONS ────────────────────────────
  {
    name: "execute_batch",
    description: "Execute multiple API requests in a single $batch call. Each request has method, url (relative to API base), and optional body. All write operations are wrapped in a changeset (atomic).",
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          description: "Array of {method, url, body?} objects",
          items: {
            type: "object",
            properties: {
              method: { type: "string", description: "HTTP method (GET, POST, PATCH, DELETE)" },
              url: { type: "string", description: "Relative URL (e.g. 'accounts?$top=5')" },
              body: { type: "object", description: "Request body for POST/PATCH" },
            },
            required: ["method", "url"],
          },
        },
      },
      required: ["requests"],
    },
  },

  // ───────────────────────── POWER AUTOMATE (CLOUD FLOWS) ────────────────────
  {
    name: "list_cloud_flows",
    description: "List Power Automate cloud flows (Dataverse workflow rows with category 5) — id, name, On/Off, type (Power Automate / Copilot Studio agent flow / M365 agent flow), managed, owner. Filter by name, state, solution, the Dataverse table that triggers them, or any text inside their definition (impact analysis: which flows reference a field, env var, child flow id, connector).",
    inputSchema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Substring of the flow name" },
        state: { type: "string", enum: ["on", "off", "all"], description: "Default all" },
        solution: { type: "string", description: "Solution unique name — only flows in that solution" },
        flow_type: { type: "string", enum: ["power_automate", "copilot_studio", "m365_agent", "all"], description: "Default all" },
        trigger_table: { type: "string", description: "Only flows with a Dataverse row trigger on this table logical name (e.g. 'incident'); adds the trigger's change type/filters to each result" },
        definition_contains: { type: "string", description: "Only flows whose definition JSON contains this text (case-insensitive), e.g. a column name, an environment variable schema name, a child flow id" },
        include_managed: { type: "boolean", description: "Default true. false = only unmanaged flows (the ones authored in this org)" },
        top: { type: "number", description: "Max results (default 100, max 500)" },
      },
    },
  },
  {
    name: "get_cloud_flow",
    description: "Read one cloud flow: state, owner, solutions, a trigger summary (for Dataverse triggers: table, change type, scope, filtering attributes), an action outline, each connection reference with whether it exists/is bound/who owns it, the 5 latest runs, a maker-portal link, `version` (pass to update_cloud_flow as expected_version), and the full `definition` JSON to edit. For On flows with a Dataverse trigger it also checks the trigger is actually registered — a flow can be On and never fire.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "workflowid GUID (from list_cloud_flows). Preferred." },
        name: { type: "string", description: "Exact flow name, if you have no id. Fails if several flows share it." },
        include_definition: { type: "boolean", description: "Default true. false = summary only (large flows can be 100KB+)." },
      },
    },
  },
  {
    name: "validate_cloud_flow",
    description: "Dry-run check of a cloud flow definition against this environment — writes nothing. Catches what turning a flow on would reject (bad runAfter targets, unterminated @{ expressions, connector actions whose connectionName is not a declared connection reference, missing/unbound/mismatched connection references, Dataverse table names — the row trigger takes the logical name, actions take the entity set name) and Dataverse-trigger mistakes that activation does NOT reject but that stop the flow ever firing (e.g. filteringattributes on a Created-only trigger). create/update_cloud_flow run the same checks.",
    inputSchema: {
      type: "object",
      properties: {
        definition: { type: "object", description: "The Logic Apps definition ({ triggers, actions, ... }) — or a whole clientdata / properties object, as returned by get_cloud_flow or the portal's Peek code." },
        connection_references: { type: "object", description: "Map of connectionName key → connection reference logical name, e.g. { \"shared_commondataserviceforapps\": \"new_sharedcommondataserviceforapps_a1b2c\" }. Keys must equal the inputs.host.connectionName used by actions." },
      },
      required: ["definition"],
    },
  },
  {
    name: "create_cloud_flow",
    description: "Create a solution-aware Power Automate cloud flow in Dataverse. Validates first (same checks as validate_cloud_flow) and writes nothing on error; adds the $connections/$authentication parameters and schema boilerplate if missing. Pass `solution` so it travels with ALM — without it the flow lands in the Default solution. Created Off by default; Draft flows are NOT validated by the Flow service, so pass activate: true (or call set_cloud_flow_state) to validate and deploy. Activation takes ~10s; for Dataverse triggers the tool then confirms the webhook registered. Use connection references you own — someone else's connection fails with 'Cannot find connection'. Author in a development environment, never directly in production.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Flow display name" },
        definition: { type: "object", description: "The Logic Apps definition: { triggers: {<one trigger>}, actions: {...} }. A full clientdata or properties object is also accepted." },
        connection_references: { type: "object", description: "Map of connectionName key → connection reference logical name, e.g. { \"shared_commondataserviceforapps\": \"new_sharedcommondataserviceforapps_a1b2c\" }. Every connector action's inputs.host.connectionName must be one of these keys. Find references with list_connection_references." },
        description: { type: "string" },
        solution: { type: "string", description: "Unique name of the unmanaged solution to create it in (strongly recommended)" },
        activate: { type: "boolean", description: "Turn the flow on after creating it (default false). If activation fails the flow stays, Off, and the cause + fix are returned." },
      },
      required: ["name", "definition"],
    },
  },
  {
    name: "update_cloud_flow",
    description: "Update a cloud flow's name, description, definition (full replacement — read it with get_cloud_flow, edit, send back) and/or connection references. Validates first. If the flow is On, the Flow service validates and deploys the change immediately, and rejects it as a whole if invalid (the flow keeps running its previous definition). If Off, the change is stored unvalidated — turn it on to validate. Pass expected_version (from get_cloud_flow) to refuse the write if someone saved the flow since you read it. Refuses managed flows (that would create an unmanaged layer over the managed solution) unless allow_managed is true.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "workflowid GUID" },
        name: { type: "string" },
        description: { type: "string" },
        definition: { type: "object", description: "Complete new Logic Apps definition (not a patch)." },
        connection_references: { type: "object", description: "connectionName key → connection reference logical name. Merged over the flow's existing references." },
        expected_version: { type: "string", description: "The `version` from get_cloud_flow — optimistic concurrency (If-Match)." },
        allow_managed: { type: "boolean", description: "Default false. true = deliberately create an unmanaged layer on a managed flow." },
      },
      required: ["flow_id"],
    },
  },
  {
    name: "set_cloud_flow_state",
    description: "Turn a cloud flow on, off, or restart it (off then on). Turning on is where the Flow service validates the definition and connections; failures come back with their real cause and fix (e.g. 'Cannot find connection' = the connection is not shared with you). For Dataverse-triggered flows it then confirms the trigger's webhook registered. Restart is needed after rebinding a connection reference: active flows keep their old connection until restarted.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "workflowid GUID" },
        state: { type: "string", enum: ["on", "off", "restart"] },
      },
      required: ["flow_id", "state"],
    },
  },
  {
    name: "delete_cloud_flow",
    description: "Permanently delete a cloud flow from Dataverse and the Flow service (works while On). Refuses managed flows, and refuses when other flows reference this flow's id (child flows) unless force is true. Irreversible — export the solution first if you may want it back.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "workflowid GUID" },
        force: { type: "boolean", description: "Delete even if other flows reference it (default false)" },
      },
      required: ["flow_id"],
    },
  },
  {
    name: "list_cloud_flow_runs",
    description: "Cloud flow run history from Dataverse (flowrun table): status, trigger type, start/end, duration, error code + message, and a portal link per run. Filter by flow, status, and start time; with a flow it also returns per-status counts. Runs arrive ~5 minutes after they finish, are kept 28 days, and in-progress runs are not listed.",
    inputSchema: {
      type: "object",
      properties: {
        flow_id: { type: "string", description: "workflowid GUID — omit for runs across all flows" },
        status: { type: "string", enum: ["Succeeded", "Failed", "Cancelled"] },
        since: { type: "string", description: "ISO date/time — only runs started at or after it" },
        top: { type: "number", description: "Max runs (default 50, max 500), newest first" },
      },
    },
  },
  {
    name: "cancel_cloud_flow_runs",
    description: "Cancel every in-progress run of a cloud flow (Dataverse CancelAllCloudFlowRuns). Does not turn the flow off — new triggers still start new runs, so set_cloud_flow_state off first if it is misbehaving.",
    inputSchema: {
      type: "object",
      properties: { flow_id: { type: "string", description: "workflowid GUID" } },
      required: ["flow_id"],
    },
  },
  {
    name: "list_connection_references",
    description: "List connection references (how solution-aware flows bind to connectors): logical name, connector, whether a connection is bound, owner, and whether you own it. Use before create_cloud_flow to pick a reference you own. include_flows adds the flows using each reference.",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string", description: "Connector filter, e.g. 'commondataserviceforapps', 'keyvault', 'office365'" },
        name_contains: { type: "string", description: "Substring of the logical or display name" },
        unbound_only: { type: "boolean", description: "Only references with no connection" },
        include_flows: { type: "boolean", description: "Also list the flows using each reference (max 25 references)" },
        top: { type: "number", description: "Max results (default 100, max 500)" },
      },
    },
  },
  {
    name: "create_connection_reference",
    description: "Create a connection reference for a connector, optionally in a solution and already bound to a connection id (Dataverse checks the connection exists and that you can use it). Unbound references are normal for ALM — bind them per environment.",
    inputSchema: {
      type: "object",
      properties: {
        logical_name: { type: "string", description: "Publisher-prefixed logical name, e.g. new_sharedcommondataserviceforapps_tickets" },
        connector: { type: "string", description: "Connector api name, e.g. shared_commondataserviceforapps (or its full /providers/... id)" },
        display_name: { type: "string" },
        connection_id: { type: "string", description: "Connection to bind, e.g. shared-commondataser-<guid> (copy from a reference that already uses it)" },
        description: { type: "string" },
        solution: { type: "string", description: "Unique name of the solution to create it in" },
      },
      required: ["logical_name", "connector"],
    },
  },
  {
    name: "update_connection_reference",
    description: "Rebind a connection reference to another connection, or rename it. Active flows keep the connection they were activated with, so after a rebind this lists them; restart_flows: true restarts them (up to 3 per call — also works on its own as a follow-up to an earlier rebind), otherwise restart each with set_cloud_flow_state.",
    inputSchema: {
      type: "object",
      properties: {
        connection_reference: { type: "string", description: "Logical name or connectionreferenceid GUID" },
        connection_id: { type: "string", description: "New connection id to bind" },
        display_name: { type: "string" },
        description: { type: "string" },
        restart_flows: { type: "boolean", description: "Restart the active flows using it so they pick up the new connection (default false)" },
      },
      required: ["connection_reference"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────── Auth ───────────────────────────────────────────

async function handleAuthenticate(args: { method?: string; tenant_id?: string }): Promise<string> {
  const method = args.method ?? "auto";
  // Optional tenant override — reset cached credentials if it changes the tenant.
  if (args.tenant_id?.trim() && args.tenant_id.trim() !== TENANT_ID) {
    TENANT_ID = args.tenant_id.trim();
    cliCredential = null; deviceCredential = null; activeCredential = null; tokenCache.clear();
  }

  const env = activeEnvironment ?? ENVIRONMENTS[0] ?? null;
  if (!env) {
    return "No environment configured yet. Set D365_ORG_URL or D365_ENVIRONMENTS, or call add_environment, then call authenticate.";
  }
  const probeScope = `${env.url}/.default`;

  // Already signed in? Confirm silently.
  if (method === "auto" && activeCredential) {
    try {
      const tok = await activeCredential.getToken(probeScope);
      if (tok) return signedInMessage(tok.token, "already signed in");
    } catch { activeCredential = null; /* expired — re-auth below */ }
  }

  // 1) Existing Azure CLI session (silent).
  if (method === "auto" || method === "cli") {
    try {
      const tok = await getCliCredential().getToken(probeScope);
      if (tok) {
        activeCredential = getCliCredential();
        tokenCache.clear();
        return signedInMessage(tok.token, "signed in via Azure CLI");
      }
    } catch (err) {
      if (method === "cli") {
        return `✗ No usable \`az login\` session.\n\nRun \`${azLoginCmd()}\`, or call authenticate with method "az_login" to have me run it for you. (${err instanceof Error ? err.message : String(err)})`;
      }
      // method "auto": fall through and run az login for them.
    }
  }

  // 2) Run `az login` for the user (opens a browser; auth-code flow — Conditional-Access-friendly).
  if (method === "auto" || method === "az_login") {
    const az = await runAzLogin();
    if (az.ok) {
      cliCredential = null; // re-read the freshly created session
      try {
        const tok = await getCliCredential().getToken(probeScope);
        if (tok) {
          activeCredential = getCliCredential();
          tokenCache.clear();
          return signedInMessage(tok.token, "signed in via az login");
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return conditionalAccessHelp(m) ?? `⚠ az login completed but couldn't get a token: ${m}`;
      }
    } else if (az.reason === "not_installed") {
      // The Azure CLI is required. Don't fall back to device-code — it's commonly blocked by
      // Conditional Access and only yields a cryptic "authentication flow restricted" page.
      return `✗ The Azure CLI isn't installed — it's required to sign in.\n\n${azInstallHint()}\n\nThen call authenticate again.`;
    } else {
      const help = conditionalAccessHelp(az.message);
      if (help) return `✗ Sign-in was blocked.\n\n${help}`;
      return `✗ Couldn't complete az login: ${az.message}\n\nTry \`${azLoginCmd()}\` yourself, then call auth_status.`;
    }
  }

  // Only an explicit method "device_code" reaches the device-code flow below. auto/cli/az_login
  // never silently attempt it, because it's frequently blocked by Conditional Access.
  if (method !== "device_code") {
    return `✗ Couldn't establish a session.\n\n${azInstallHint()}\n\nIf the CLI is already installed, run \`${azLoginCmd()}\` and call auth_status.`;
  }

  // 3) Device-code sign-in — opt-in only. Two-phase: return the code now, finish in the background.
  if (deviceLoginInFlight && pendingDeviceCode && !activeCredential) {
    return deviceCodePrompt("Sign-in already in progress");
  }
  const cred = getDeviceCredential();
  pendingDeviceCode = null;
  deviceLoginError = null;
  deviceLoginInFlight = cred.authenticate(probeScope)
    .then(() => { activeCredential = cred; tokenCache.clear(); pendingDeviceCode = null; })
    .catch((err) => { deviceLoginError = err instanceof Error ? err.message : String(err); })
    .finally(() => { deviceLoginInFlight = null; });

  // Wait briefly for Entra to issue the code (userPromptCallback fires within ~1s).
  for (let i = 0; i < 30 && !pendingDeviceCode && !deviceLoginError; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (deviceLoginError) {
    const e = deviceLoginError; deviceLoginError = null;
    const help = conditionalAccessHelp(e);
    return help ? `✗ Device-code sign-in was blocked.\n\n${help}` : `✗ Sign-in failed: ${e}`;
  }
  if (!pendingDeviceCode) return "Starting sign-in… call auth_status in a moment to get your device code.";
  return deviceCodePrompt("🔐 Device sign-in started");
}

function deviceCodePrompt(prefix: string): string {
  return `${prefix}.\n\n👉 Open ${pendingDeviceCode!.verificationUri} and enter code: ${pendingDeviceCode!.userCode}\n\n` +
    "After you approve in the browser, call auth_status (or just run any tool). Your writes will be attributed to you.";
}

function signedInMessage(token: string, how: string): string {
  const who = identityFromToken(token);
  const envInfo = activeEnvironment
    ? `Active environment: ${activeEnvironment.name}.`
    : (ENVIRONMENTS.length ? "Call list_environments → select_environment to pick one." : "No environments configured — use add_environment.");
  return `✓ ${how}${who ? ` as ${who}` : ""}. Your Dataverse writes are now attributed to you.\n${envInfo}`;
}

async function handleAuthStatus(): Promise<string> {
  const env = activeEnvironment ?? ENVIRONMENTS[0] ?? null;
  const probe = env ? `${env.url}/.default` : null;

  if (deviceLoginError) {
    const e = deviceLoginError; deviceLoginError = null; pendingDeviceCode = null;
    const help = conditionalAccessHelp(e);
    return help ? `✗ Device-code sign-in was blocked.\n\n${help}` : `✗ Sign-in failed: ${e}\n\nCall authenticate to try again.`;
  }
  if (deviceLoginInFlight && pendingDeviceCode) return deviceCodePrompt("⏳ Waiting for you to finish sign-in");

  // No active credential yet? See if an existing `az login` session works (needs a scope to probe).
  if (!activeCredential && probe) {
    try { const tok = await getCliCredential().getToken(probe); if (tok) activeCredential = getCliCredential(); } catch { /* no session */ }
  }

  const envInfo = activeEnvironment
    ? `Active environment: ${activeEnvironment.name} (${activeEnvironment.url})`
    : (ENVIRONMENTS.length ? `Available environments: ${ENVIRONMENTS.map((e) => e.name).join(", ")} — call select_environment.` : "No environment configured — set D365_ORG_URL / D365_ENVIRONMENTS or use add_environment.");

  if (!activeCredential) {
    return `✗ Not signed in.\n\nRun \`${azLoginCmd()}\` then call any tool, or call authenticate to sign in.\n${envInfo}`;
  }
  try {
    const tok = probe ? await activeCredential.getToken(probe) : null;
    pendingDeviceCode = null;
    const who = tok ? identityFromToken(tok.token) : null;
    return `✓ Signed in${who ? ` as ${who}` : ""}.\n${envInfo}`;
  } catch (err) {
    activeCredential = null;
    return `⚠ Session expired: ${err instanceof Error ? err.message : String(err)}\n\nCall authenticate to sign in again.`;
  }
}

// ───────────────────────────── Environment ────────────────────────────────────

function handleListEnvironments(): string {
  if (!ENVIRONMENTS.length) {
    return "No environments configured.\n\nAsk the user for their Dataverse org URL, then call add_environment with it. Example URL: https://myorg.crm.dynamics.com";
  }
  const lines = ["Available D365 environments:", "",
    ...ENVIRONMENTS.map((e, i) => {
      const a = activeEnvironment?.name === e.name ? " ✓ (active)" : "";
      return `${i + 1}. **${e.name}**${a}\n   ${e.url}`;
    }), "",
    activeEnvironment ? `Currently: **${activeEnvironment.name}**` : "No environment selected — call select_environment with one of the names above.",
  ];
  return lines.join("\n");
}

function handleSelectEnvironment(args: { name: string }): string {
  const env = ENVIRONMENTS.find((e) => e.name.toLowerCase() === args.name.toLowerCase());
  if (!env) throw new Error(`"${args.name}" not found. Available: ${ENVIRONMENTS.map((e) => e.name).join(", ")}`);
  activeEnvironment = env;
  return `✓ Now working in **${env.name}** (${env.url}).`;
}

function handleAddEnvironment(args: { url: string; name?: string; select?: boolean }): string {
  const url = args.url.replace(/\/$/, "");
  const name = args.name || nameFromUrl(url);
  const existing = ENVIRONMENTS.find((e) => e.url.toLowerCase() === url.toLowerCase());
  if (existing) {
    if (args.select !== false) { activeEnvironment = existing; }
    return `Environment **${existing.name}** already exists.${args.select !== false ? " Selected." : ""}`;
  }
  const env: D365Environment = { name, url };
  ENVIRONMENTS.push(env);
  if (args.select !== false) activeEnvironment = env;
  return `✓ Added **${name}** (${url}).${args.select !== false ? " Selected as active." : ""}`;
}

// ───────────────────────────── Metadata ──────────────────────────────────────

async function handleListEntities(args: { filter?: string; custom_only?: boolean }) {
  requireEnv();
  const f: string[] = [];
  if (args.filter) f.push(`contains(LogicalName,'${args.filter.toLowerCase()}')`);
  if (args.custom_only) f.push("IsCustomEntity eq true");
  const fqs = f.length ? `$filter=${f.join(" and ")}&` : "";
  return d365(`EntityDefinitions?${fqs}$select=LogicalName,ObjectTypeCode,IsCustomEntity,DisplayName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`);
}

async function handleGetEntityDetails(args: { entity_logical_name: string }) {
  requireEnv();
  return d365(`EntityDefinitions(LogicalName='${args.entity_logical_name}')?$select=LogicalName,DisplayName,ObjectTypeCode,IsCustomEntity,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,Description`);
}

async function handleGetEntityAttributes(args: { entity_logical_name: string; include_option_sets?: boolean }) {
  requireEnv();
  const base = (await d365(
    `EntityDefinitions(LogicalName='${args.entity_logical_name}')/Attributes?$select=LogicalName,DisplayName,AttributeType,IsCustomAttribute,RequiredLevel,AttributeTypeName`
  )) as { value: any[] };

  if (args.include_option_sets !== false) {
    const picklists = base.value.filter((a: any) =>
      a.AttributeType === "Picklist" || a.AttributeType === "Status" || a.AttributeType === "State"
    );
    const results = await Promise.allSettled(
      picklists.map(async (attr: any) => {
        const data = (await d365(
          `EntityDefinitions(LogicalName='${args.entity_logical_name}')/Attributes(LogicalName='${attr.LogicalName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=IsGlobal,Name,Options),GlobalOptionSet($select=Name,Options)`
        )) as any;
        return { ln: attr.LogicalName, os: data.OptionSet || data.GlobalOptionSet };
      })
    );
    const osMap = new Map<string, any>();
    for (const r of results) if (r.status === "fulfilled" && r.value.os) osMap.set(r.value.ln, r.value.os);
    base.value = base.value.map((a: any) => { const os = osMap.get(a.LogicalName); return os ? { ...a, OptionSet: os } : a; });
  }
  return base;
}

async function handleGetEntityRelationships(args: { entity_logical_name: string; type?: string }) {
  requireEnv();
  const n = args.entity_logical_name;
  const so = "$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencedAttribute,ReferencingAttribute";
  const sm = "$select=SchemaName,Entity1LogicalName,Entity2LogicalName";
  if (args.type === "OneToMany") return d365(`EntityDefinitions(LogicalName='${n}')/OneToManyRelationships?${so}`);
  if (args.type === "ManyToOne") return d365(`EntityDefinitions(LogicalName='${n}')/ManyToOneRelationships?${so}`);
  if (args.type === "ManyToMany") return d365(`EntityDefinitions(LogicalName='${n}')/ManyToManyRelationships?${sm}`);
  const [o, m, mm] = await Promise.all([
    d365(`EntityDefinitions(LogicalName='${n}')/OneToManyRelationships?${so}`),
    d365(`EntityDefinitions(LogicalName='${n}')/ManyToOneRelationships?${so}`),
    d365(`EntityDefinitions(LogicalName='${n}')/ManyToManyRelationships?${sm}`),
  ]);
  return { OneToMany: (o as any).value, ManyToOne: (m as any).value, ManyToMany: (mm as any).value };
}

async function handleGetEntityKeys(args: { entity_logical_name: string }) {
  requireEnv();
  return d365(`EntityDefinitions(LogicalName='${args.entity_logical_name}')/Keys?$select=LogicalName,DisplayName,KeyAttributes`);
}

async function handleGetPicklistOptions(args: { entity_logical_name: string; attribute_logical_name: string }) {
  requireEnv();
  return d365(
    `EntityDefinitions(LogicalName='${args.entity_logical_name}')/Attributes(LogicalName='${args.attribute_logical_name}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=IsGlobal,Name,Options),GlobalOptionSet($select=Name,Options)`
  );
}

async function handleGetGlobalOptionSets(args: { filter?: string }) {
  requireEnv();
  const fq = args.filter ? `$filter=contains(Name,'${args.filter}')&` : "";
  return d365(`GlobalOptionSetDefinitions?${fq}$select=Name,DisplayName,Description,IsGlobal`);
}

async function handleGetGlobalOptionSetDetails(args: { name: string }) {
  requireEnv();
  return d365(`GlobalOptionSetDefinitions(Name='${args.name}')`);
}

// ───────────────────────────── Data Operations ───────────────────────────────

async function handleQueryRecords(args: {
  entity: string; select?: string; filter?: string; orderby?: string;
  top?: number; expand?: string; count?: boolean;
}) {
  requireEnv();
  const p = new URLSearchParams();
  if (args.select) p.set("$select", args.select);
  if (args.filter) p.set("$filter", args.filter);
  if (args.orderby) p.set("$orderby", args.orderby);
  p.set("$top", String(Math.min(args.top ?? 50, 5000)));
  if (args.expand) p.set("$expand", args.expand);
  if (args.count) p.set("$count", "true");
  const qs = p.toString();
  return d365(`${args.entity}${qs ? `?${qs}` : ""}`);
}

async function handleGetRecord(args: { entity: string; id: string; select?: string; expand?: string }) {
  requireEnv();
  const p = new URLSearchParams();
  if (args.select) p.set("$select", args.select);
  if (args.expand) p.set("$expand", args.expand);
  const qs = p.toString();
  return d365(`${args.entity}(${args.id})${qs ? `?${qs}` : ""}`);
}

async function handleCreateRecord(args: { entity: string; data: Record<string, unknown> }) {
  requireEnv();
  const baseUrl = getBaseUrl();
  const token = await getAccessToken(activeEnvironment!.url);
  const res = await fetch(`${baseUrl}/${args.entity}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, "OData-MaxVersion": "4.0", "OData-Version": "4.0",
      Accept: "application/json", "Content-Type": "application/json", Prefer: "return=representation",
    },
    body: JSON.stringify(args.data),
  });
  if (!res.ok) throw new Error(`Create error ${res.status}: ${await res.text()}`);
  if (res.status === 204) {
    const eid = res.headers.get("OData-EntityId") ?? "";
    const m = eid.match(/\(([^)]+)\)$/);
    return { success: true, id: m?.[1] ?? eid };
  }
  return res.json();
}

async function handleUpdateRecord(args: { entity: string; id: string; data: Record<string, unknown> }) {
  requireEnv(); return d365(`${args.entity}(${args.id})`, "PATCH", args.data);
}
async function handleDeleteRecord(args: { entity: string; id: string }) {
  requireEnv(); return d365(`${args.entity}(${args.id})`, "DELETE");
}
async function handleExecuteFetchXml(args: { entity: string; fetchxml: string }) {
  requireEnv(); return d365(`${args.entity}?fetchXml=${encodeURIComponent(args.fetchxml)}`);
}
async function handleExecuteAction(args: { action_name: string; parameters?: Record<string, unknown>; entity?: string; entity_id?: string }) {
  requireEnv();
  const path = args.entity && args.entity_id
    ? `${args.entity}(${args.entity_id})/Microsoft.Dynamics.CRM.${args.action_name}`
    : args.action_name;
  return d365(path, "POST", args.parameters ?? {});
}
async function handleAssociateRecords(args: { entity: string; id: string; relationship: string; related_entity: string; related_id: string }) {
  requireEnv();
  return d365(`${args.entity}(${args.id})/${args.relationship}/$ref`, "POST",
    { "@odata.id": `${getBaseUrl()}/${args.related_entity}(${args.related_id})` });
}

// ──────────────────────── Bulk Delete Operations ──────────────────────────

async function handleCreateBulkDeleteJob(args: {
  job_name: string;
  entity: string;
  filter_conditions?: Array<{ attribute: string; operator: string; values?: string[] }>;
  start_datetime?: string;
  recurrence_pattern?: string;
  send_email_notification?: boolean;
}) {
  requireEnv();
  const query: Record<string, unknown> = {
    "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression",
    EntityName: args.entity,
    ColumnSet: { "@odata.type": "Microsoft.Dynamics.CRM.ColumnSet", AllColumns: false, Columns: [`${args.entity}id`] },
    Distinct: false,
    NoLock: false,
  };
  if (args.filter_conditions && args.filter_conditions.length > 0) {
    query.Criteria = {
      "@odata.type": "Microsoft.Dynamics.CRM.FilterExpression",
      FilterOperator: "And",
      Conditions: args.filter_conditions.map((c) => ({
        "@odata.type": "Microsoft.Dynamics.CRM.ConditionExpression",
        AttributeName: c.attribute,
        Operator: c.operator,
        Values: c.values ?? [],
      })),
    };
  }
  return d365("BulkDelete", "POST", {
    QuerySet: [query],
    JobName: args.job_name,
    SendEmailNotification: args.send_email_notification ?? false,
    ToRecipients: [],
    CCRecipients: [],
    RecurrencePattern: args.recurrence_pattern ?? "",
    StartDateTime: args.start_datetime ?? new Date().toISOString(),
  });
}

async function handleListBulkDeleteJobs(args: { status?: string; top?: number }) {
  requireEnv();
  const statusFilters: Record<string, string> = {
    waiting: "statuscode eq 10",
    running: "statuscode eq 20",
    completed: "statecode eq 3 and statuscode eq 30",
    failed: "statecode eq 3 and statuscode eq 33",
    cancelled: "statecode eq 3 and statuscode eq 32",
  };
  const top = Math.min(args.top ?? 20, 100);
  const statusClause = args.status && statusFilters[args.status] ? ` and (${statusFilters[args.status]})` : "";
  return d365(
    `asyncoperations?$filter=operationtype eq 13${statusClause}&$select=asyncoperationid,name,statecode,statuscode,createdon,completedon,message&$orderby=createdon desc&$top=${top}`
  );
}

async function handleGetBulkDeleteJob(args: { job_id: string }) {
  requireEnv();
  return d365(
    `asyncoperations(${args.job_id})?$select=asyncoperationid,name,statecode,statuscode,createdon,completedon,message,operationtype`
  );
}

async function handleCancelBulkDeleteJob(args: { job_id: string }) {
  requireEnv();
  return d365(`asyncoperations(${args.job_id})`, "DELETE");
}

async function handleGetBulkDeleteFailures(args: { job_id: string; top?: number }) {
  requireEnv();
  const top = Math.min(args.top ?? 50, 500);
  return d365(
    `bulkdeletefailures?$filter=asyncoperationid/asyncoperationid eq ${args.job_id}&$select=bulkdeletefailureid,objectid,orderfailure,errordescription&$top=${top}`
  );
}

// ───────────────────────────── Security & Users ──────────────────────────────

async function handleGetCurrentUser() {
  requireEnv();
  return d365("WhoAmI");
}

async function handleFindUsers(args: { keyword: string; top?: number }) {
  requireEnv();
  const k = args.keyword.replace(/'/g, "''");
  const top = Math.min(args.top ?? 20, 100);
  return d365(
    `systemusers?$filter=(contains(fullname,'${k}') or contains(internalemailaddress,'${k}') or contains(domainname,'${k}'))&$select=systemuserid,fullname,internalemailaddress,domainname,isdisabled,businessunitid&$top=${top}&$orderby=fullname asc`
  );
}

async function handleGetUserRoles(args: { user_id: string }) {
  requireEnv();
  return d365(`systemusers(${args.user_id})/systemuserroles_association?$select=roleid,name`);
}

async function handleGetUserTeams(args: { user_id: string }) {
  requireEnv();
  return d365(`systemusers(${args.user_id})/teammembership_association?$select=teamid,name,teamtype`);
}

async function handleGetUserQueues(args: { user_id: string }) {
  requireEnv();
  return d365(`queues?$filter=_ownerid_value eq ${args.user_id}&$select=queueid,name,emailaddress`);
}

async function handleListSecurityRoles(args: { filter?: string }) {
  requireEnv();
  const fq = args.filter ? `$filter=contains(name,'${args.filter.replace(/'/g, "''")}')&` : "";
  return d365(`roles?${fq}$select=roleid,name,ismanaged,iscustomizable&$orderby=name asc`);
}

async function handleGetRolePrivileges(args: { role_id: string }) {
  requireEnv();
  return d365(`roles(${args.role_id})/roleprivileges_association?$select=privilegeid,name`);
}

async function handleCompareRolePrivileges(args: { role_id_1: string; role_id_2: string; role_name_1?: string; role_name_2?: string }) {
  requireEnv();
  const [privs1, privs2] = await Promise.all([
    d365(`roles(${args.role_id_1})/roleprivileges_association?$select=privilegeid,name`) as Promise<{ value: any[] }>,
    d365(`roles(${args.role_id_2})/roleprivileges_association?$select=privilegeid,name`) as Promise<{ value: any[] }>,
  ]);

  const set1 = new Set(privs1.value.map((p: any) => p.name));
  const set2 = new Set(privs2.value.map((p: any) => p.name));

  const onlyIn1 = privs1.value.filter((p: any) => !set2.has(p.name)).map((p: any) => p.name).sort();
  const onlyIn2 = privs2.value.filter((p: any) => !set1.has(p.name)).map((p: any) => p.name).sort();
  const shared = privs1.value.filter((p: any) => set2.has(p.name)).map((p: any) => p.name).sort();

  return {
    role1: { name: args.role_name_1 || args.role_id_1, total_privileges: privs1.value.length },
    role2: { name: args.role_name_2 || args.role_id_2, total_privileges: privs2.value.length },
    only_in_role1: onlyIn1,
    only_in_role2: onlyIn2,
    shared_count: shared.length,
    only_in_role1_count: onlyIn1.length,
    only_in_role2_count: onlyIn2.length,
  };
}

// ───────────────────────────── Custom Actions & APIs ─────────────────────────

async function handleFindCustomActions(args: { keyword: string; top?: number }) {
  requireEnv();
  const k = args.keyword.replace(/'/g, "''");
  const top = Math.min(args.top ?? 20, 100);
  return d365(
    `workflows?$filter=(contains(name,'${k}') or contains(uniquename,'${k}')) and category eq 3&$select=workflowid,name,uniquename,primaryentity,description,statuscode,statecode&$top=${top}&$orderby=name asc`
  );
}

async function handleGetCustomActionMetadata(args: { action_name: string }) {
  requireEnv();
  const action = (await d365(
    `workflows?$filter=uniquename eq '${args.action_name.replace(/'/g, "''")}' and category eq 3&$select=workflowid,name,uniquename,primaryentity,description,inputparameters,xaml`
  )) as { value: any[] };

  if (!action.value.length) throw new Error(`Custom action '${args.action_name}' not found.`);
  const act = action.value[0];

  const sdkSteps = (await d365(
    `sdkmessageprocessingsteps?$filter=contains(sdkmessageid/name,'${args.action_name.replace(/'/g, "''")}')&$select=name,stage,mode,statecode&$expand=plugintypeid($select=name,typename,assemblyname)&$top=10`
  )) as { value: any[] };

  return {
    ...act,
    registered_plugin_steps: sdkSteps.value,
    web_api_usage: act.primaryentity && act.primaryentity !== "none"
      ? `POST ${getBaseUrl()}/${act.primaryentity}s({id})/Microsoft.Dynamics.CRM.${act.uniquename}`
      : `POST ${getBaseUrl()}/${act.uniquename}`,
  };
}

async function handleFindCustomApis(args: { keyword: string; top?: number }) {
  requireEnv();
  const k = args.keyword.replace(/'/g, "''");
  const top = Math.min(args.top ?? 20, 100);
  return d365(
    `customapis?$filter=contains(uniquename,'${k}') or contains(name,'${k}')&$select=customapiid,uniquename,name,displayname,description,bindingtype,boundentitylogicalname,isfunction,isprivate&$top=${top}&$orderby=name asc`
  );
}

async function handleGetCustomApiMetadata(args: { unique_name: string }) {
  requireEnv();
  const api = (await d365(
    `customapis?$filter=uniquename eq '${args.unique_name.replace(/'/g, "''")}'&$select=customapiid,uniquename,name,displayname,description,bindingtype,boundentitylogicalname,isfunction,isprivate&$expand=CustomAPIRequestParameters($select=uniquename,name,displayname,type,isoptional,description,logicalentityname),CustomAPIResponseProperties($select=uniquename,name,displayname,type,description,logicalentityname),PluginTypeId($select=name,typename,assemblyname)`
  )) as { value: any[] };

  if (!api.value.length) throw new Error(`Custom API '${args.unique_name}' not found.`);
  const a = api.value[0];

  const method = a.isfunction ? "GET" : "POST";
  let endpoint: string;
  if (a.bindingtype === 1 && a.boundentitylogicalname) {
    endpoint = `${method} ${getBaseUrl()}/${a.boundentitylogicalname}s({id})/Microsoft.Dynamics.CRM.${a.uniquename}`;
  } else if (a.bindingtype === 2 && a.boundentitylogicalname) {
    endpoint = `${method} ${getBaseUrl()}/${a.boundentitylogicalname}s/Microsoft.Dynamics.CRM.${a.uniquename}`;
  } else {
    endpoint = `${method} ${getBaseUrl()}/${a.uniquename}`;
  }

  return { ...a, web_api_usage: endpoint };
}

// ───────────────────────────── Plugin Trace Logs ─────────────────────────────

async function handleGetPluginTraces(args: {
  plugin_type_name?: string; correlation_id?: string; message_name?: string;
  top?: number; hours_back?: number;
}) {
  requireEnv();
  const filters: string[] = [];
  const hoursBack = args.hours_back ?? 24;
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  filters.push(`performanceexecutionstarttime ge ${cutoff}`);

  if (args.plugin_type_name) filters.push(`contains(typename,'${args.plugin_type_name.replace(/'/g, "''")}')`);
  if (args.correlation_id) filters.push(`correlationid eq ${args.correlation_id}`);
  if (args.message_name) filters.push(`messagename eq '${args.message_name.replace(/'/g, "''")}'`);

  const top = Math.min(args.top ?? 20, 100);
  return d365(
    `plugintracelogs?$filter=${filters.join(" and ")}&$select=plugintracelogid,typename,messagename,correlationid,operationtype,mode,depth,performanceexecutionstarttime,performanceexecutionduration,exceptiondetails,messageblock&$top=${top}&$orderby=performanceexecutionstarttime desc`
  );
}

// ───────────────────────────── Solution Management ───────────────────────────

async function handleListSolutions(args: { filter?: string; unmanaged_only?: boolean }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`(contains(uniquename,'${args.filter.replace(/'/g, "''")}') or contains(friendlyname,'${args.filter.replace(/'/g, "''")}'))`);
  if (args.unmanaged_only) filters.push("ismanaged eq false");
  filters.push("isvisible eq true");
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `solutions?${fqs}$select=solutionid,uniquename,friendlyname,version,ismanaged,installedon,description&$expand=publisherid($select=friendlyname,customizationprefix)&$orderby=friendlyname asc`
  );
}

async function handleGetSolutionDetails(args: { solution_unique_name: string }) {
  requireEnv();
  return d365(
    `solutions?$filter=uniquename eq '${args.solution_unique_name.replace(/'/g, "''")}'&$select=solutionid,uniquename,friendlyname,version,ismanaged,installedon,description,createdby&$expand=publisherid($select=friendlyname,customizationprefix,uniquename)`
  );
}

async function handleGetSolutionComponents(args: { solution_id: string; component_type?: number }) {
  requireEnv();
  const filters = [`_solutionid_value eq ${args.solution_id}`];
  if (args.component_type !== undefined) filters.push(`componenttype eq ${args.component_type}`);
  return d365(
    `solutioncomponents?$filter=${filters.join(" and ")}&$select=solutioncomponentid,componenttype,objectid,rootcomponentbehavior&$top=500&$orderby=componenttype asc`
  );
}

async function handleGetSolutionDependencies(args: { solution_unique_name: string }) {
  requireEnv();
  const sol = (await d365(
    `solutions?$filter=uniquename eq '${args.solution_unique_name.replace(/'/g, "''")}'&$select=solutionid`
  )) as { value: any[] };
  if (!sol.value.length) throw new Error(`Solution '${args.solution_unique_name}' not found.`);
  return d365(`RetrieveMissingDependencies(SolutionUniqueName='${args.solution_unique_name}')`);
}

// ═════════════════════════════════════════════════════════════════════════════
// NEW IN v5: PLUGIN REGISTRATION TOOL HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ───────────────────────────── Plugin Assemblies ─────────────────────────────

async function handleListPluginAssemblies(args: { filter?: string; custom_only?: boolean }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`contains(name,'${args.filter.replace(/'/g, "''")}')`);
  // By default exclude Microsoft/System assemblies
  if (args.custom_only !== false) {
    filters.push("not startswith(name,'Microsoft')");
    filters.push("not startswith(name,'System')");
  }
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `pluginassemblies?${fqs}$select=pluginassemblyid,name,version,culture,publickeytoken,isolationmode,sourcetype,description,createdon,modifiedon&$orderby=name asc`
  );
}

async function handleGetPluginAssemblyDetails(args: { assembly_id: string }) {
  requireEnv();
  // Get assembly + all its plugin types in parallel
  const [assembly, types] = await Promise.all([
    d365(`pluginassemblies(${args.assembly_id})?$select=pluginassemblyid,name,version,culture,publickeytoken,isolationmode,sourcetype,description,createdon,modifiedon`),
    d365(`plugintypes?$filter=_pluginassemblyid_value eq ${args.assembly_id}&$select=plugintypeid,name,typename,friendlyname,isworkflowactivity,workflowactivitygroupname,description&$orderby=name asc`),
  ]);

  return {
    assembly,
    plugin_types: (types as any).value,
    summary: {
      isolation_mode: ({ 1: "None", 2: "Sandbox" } as Record<number, string>)[(assembly as any).isolationmode] ?? (assembly as any).isolationmode,
      source_type: ({ 0: "Database", 1: "Disk", 2: "Normal", 3: "AzureWebApp" } as Record<number, string>)[(assembly as any).sourcetype] ?? (assembly as any).sourcetype,
    },
  };
}

// ───────────────────────────── Plugin Types ──────────────────────────────────

async function handleListPluginTypes(args: { assembly_id?: string; filter?: string }) {
  requireEnv();
  const filters: string[] = [];
  if (args.assembly_id) filters.push(`_pluginassemblyid_value eq ${args.assembly_id}`);
  if (args.filter) filters.push(`contains(typename,'${args.filter.replace(/'/g, "''")}')`);
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `plugintypes?${fqs}$select=plugintypeid,name,typename,friendlyname,assemblyname,isworkflowactivity,workflowactivitygroupname,description&$orderby=typename asc`
  );
}

// ───────────────────────────── SDK Messages ──────────────────────────────────

async function handleListSdkMessages(args: { filter?: string; top?: number }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`contains(name,'${args.filter.replace(/'/g, "''")}')`);
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  const top = Math.min(args.top ?? 50, 200);
  return d365(
    `sdkmessages?${fqs}$select=sdkmessageid,name,isprivate,isreadonly,isvalidforexecuteasync&$top=${top}&$orderby=name asc`
  );
}

async function handleListSdkMessageFilters(args: { message_name?: string; entity_logical_name?: string }) {
  requireEnv();
  const filters: string[] = [];
  if (args.message_name) {
    // First get the message ID
    const msgs = (await d365(
      `sdkmessages?$filter=name eq '${args.message_name.replace(/'/g, "''")}'&$select=sdkmessageid`
    )) as { value: any[] };
    if (msgs.value.length) {
      filters.push(`_sdkmessageid_value eq ${msgs.value[0].sdkmessageid}`);
    }
  }
  if (args.entity_logical_name) {
    filters.push(`primaryobjecttypecode eq '${args.entity_logical_name}'`);
  }
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `sdkmessagefilters?${fqs}$select=sdkmessagefilterid,primaryobjecttypecode,secondaryobjecttypecode,isvisible&$top=100&$orderby=primaryobjecttypecode asc`
  );
}

// ───────────────────────────── Processing Steps ──────────────────────────────

async function handleListProcessingSteps(args: { plugin_type_id?: string; assembly_name?: string; message_name?: string; top?: number }) {
  requireEnv();
  const filters: string[] = [];
  if (args.plugin_type_id) filters.push(`_plugintypeid_value eq ${args.plugin_type_id}`);
  if (args.assembly_name) filters.push(`contains(plugintypeid/assemblyname,'${args.assembly_name.replace(/'/g, "''")}')`);
  if (args.message_name) filters.push(`contains(sdkmessageid/name,'${args.message_name.replace(/'/g, "''")}')`);
  // Exclude internal Microsoft steps
  filters.push("ishidden eq false");
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  const top = Math.min(args.top ?? 50, 200);
  return d365(
    `sdkmessageprocessingsteps?${fqs}$select=sdkmessageprocessingstepid,name,stage,mode,rank,statecode,statuscode,filteringattributes,configuration,asyncautodelete,description&$expand=plugintypeid($select=plugintypeid,typename,assemblyname),sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode),eventhandler_serviceendpoint($select=name)&$top=${top}&$orderby=name asc`
  );
}

async function handleGetProcessingStepDetails(args: { step_id: string }) {
  requireEnv();
  const [step, images] = await Promise.all([
    d365(
      `sdkmessageprocessingsteps(${args.step_id})?$select=sdkmessageprocessingstepid,name,stage,mode,rank,statecode,statuscode,filteringattributes,configuration,asyncautodelete,description,impersonatinguserid&$expand=plugintypeid($select=plugintypeid,typename,assemblyname,friendlyname),sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode,secondaryobjecttypecode),eventhandler_serviceendpoint($select=name,serviceendpointid)`
    ),
    d365(
      `sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${args.step_id}&$select=sdkmessageprocessingstepimageid,name,entityalias,imagetype,attributes,messagepropertyname&$orderby=imagetype asc`
    ),
  ]);

  const s = step as any;
  return {
    ...s,
    images: (images as any).value,
    summary: {
      stage: ({ 10: "PreValidation", 20: "PreOperation", 40: "PostOperation" } as Record<number, string>)[s.stage] ?? s.stage,
      mode: s.mode === 0 ? "Synchronous" : "Asynchronous",
      state: s.statecode === 0 ? "Enabled" : "Disabled",
      plugin: s.plugintypeid?.typename ?? "N/A",
      message: s.sdkmessageid?.name ?? "N/A",
      entity: s.sdkmessagefilterid?.primaryobjecttypecode ?? "N/A",
    },
  };
}

async function handleRegisterProcessingStep(args: {
  name: string; plugin_type_id: string; sdk_message_id: string;
  sdk_message_filter_id?: string; stage: number; mode: number;
  rank?: number; filtering_attributes?: string; configuration?: string;
  impersonating_user_id?: string; async_auto_delete?: boolean; description?: string;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    name: args.name,
    stage: args.stage,
    mode: args.mode,
    rank: args.rank ?? 1,
    supporteddeployment: 0, // ServerOnly
    asyncautodelete: args.async_auto_delete ?? false,
    "plugintypeid@odata.bind": `/plugintypes(${args.plugin_type_id})`,
    "sdkmessageid@odata.bind": `/sdkmessages(${args.sdk_message_id})`,
  };
  if (args.sdk_message_filter_id) {
    data["sdkmessagefilterid@odata.bind"] = `/sdkmessagefilters(${args.sdk_message_filter_id})`;
  }
  if (args.filtering_attributes) data.filteringattributes = args.filtering_attributes;
  if (args.configuration) data.configuration = args.configuration;
  if (args.description) data.description = args.description;
  if (args.impersonating_user_id) {
    data["impersonatinguserid@odata.bind"] = `/systemusers(${args.impersonating_user_id})`;
  }

  return d365("sdkmessageprocessingsteps", "POST", data);
}

async function handleUpdateProcessingStep(args: {
  step_id: string; name?: string; stage?: number; mode?: number;
  rank?: number; filtering_attributes?: string; configuration?: string;
  impersonating_user_id?: string; async_auto_delete?: boolean; description?: string;
}) {
  requireEnv();
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  if (args.stage !== undefined) data.stage = args.stage;
  if (args.mode !== undefined) data.mode = args.mode;
  if (args.rank !== undefined) data.rank = args.rank;
  if (args.filtering_attributes !== undefined) data.filteringattributes = args.filtering_attributes;
  if (args.configuration !== undefined) data.configuration = args.configuration;
  if (args.async_auto_delete !== undefined) data.asyncautodelete = args.async_auto_delete;
  if (args.description !== undefined) data.description = args.description;
  if (args.impersonating_user_id) {
    data["impersonatinguserid@odata.bind"] = `/systemusers(${args.impersonating_user_id})`;
  }

  return d365(`sdkmessageprocessingsteps(${args.step_id})`, "PATCH", data);
}

async function handleToggleProcessingStep(args: { step_id: string; enable: boolean }) {
  requireEnv();
  const setState = {
    statecode: args.enable ? 0 : 1,
    statuscode: args.enable ? 1 : 2,
  };
  return d365(`sdkmessageprocessingsteps(${args.step_id})`, "PATCH", setState);
}

async function handleDeleteProcessingStep(args: { step_id: string }) {
  requireEnv();
  return d365(`sdkmessageprocessingsteps(${args.step_id})`, "DELETE");
}

// ───────────────────────────── Step Images ────────────────────────────────────

async function handleListStepImages(args: { step_id: string }) {
  requireEnv();
  return d365(
    `sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${args.step_id}&$select=sdkmessageprocessingstepimageid,name,entityalias,imagetype,attributes,messagepropertyname&$orderby=imagetype asc`
  );
}

async function handleRegisterStepImage(args: {
  step_id: string; name: string; entity_alias: string; image_type: number;
  attributes?: string; message_property_name?: string;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    name: args.name,
    entityalias: args.entity_alias,
    imagetype: args.image_type,
    messagepropertyname: args.message_property_name ?? "Target",
    "sdkmessageprocessingstepid@odata.bind": `/sdkmessageprocessingsteps(${args.step_id})`,
  };
  if (args.attributes) data.attributes = args.attributes;

  return d365("sdkmessageprocessingstepimages", "POST", data);
}

async function handleUpdateStepImage(args: {
  image_id: string; name?: string; entity_alias?: string; image_type?: number; attributes?: string;
}) {
  requireEnv();
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  if (args.entity_alias !== undefined) data.entityalias = args.entity_alias;
  if (args.image_type !== undefined) data.imagetype = args.image_type;
  if (args.attributes !== undefined) data.attributes = args.attributes;

  return d365(`sdkmessageprocessingstepimages(${args.image_id})`, "PATCH", data);
}

async function handleDeleteStepImage(args: { image_id: string }) {
  requireEnv();
  return d365(`sdkmessageprocessingstepimages(${args.image_id})`, "DELETE");
}

// ───────────────────────────── Service Endpoints & Webhooks ──────────────────

async function handleListServiceEndpoints(args: { filter?: string; contract_type?: number }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`contains(name,'${args.filter.replace(/'/g, "''")}')`);
  if (args.contract_type !== undefined) filters.push(`contract eq ${args.contract_type}`);
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `serviceendpoints?${fqs}$select=serviceendpointid,name,url,contract,authtype,messageformat,namespaceaddress,path,description,createdon,modifiedon&$orderby=name asc`
  );
}

async function handleGetServiceEndpointDetails(args: { endpoint_id: string }) {
  requireEnv();
  const [endpoint, steps] = await Promise.all([
    d365(
      `serviceendpoints(${args.endpoint_id})?$select=serviceendpointid,name,url,contract,authtype,messageformat,namespaceaddress,path,description,createdon,modifiedon`
    ),
    d365(
      `sdkmessageprocessingsteps?$filter=_eventhandler_value eq ${args.endpoint_id}&$select=sdkmessageprocessingstepid,name,stage,mode,statecode&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode)&$orderby=name asc`
    ),
  ]);

  const e = endpoint as any;
  return {
    ...e,
    registered_steps: (steps as any).value,
    summary: {
      contract: ({ 1: "Queue", 2: "Topic", 3: "OneWay", 4: "TwoWay", 5: "REST", 7: "EventHub", 8: "Webhook" } as Record<number, string>)[e.contract] ?? e.contract,
      auth_type: ({ 1: "SASKey", 2: "SASToken", 3: "Claims", 4: "HttpHeader", 5: "WebhookKey", 6: "HttpQueryString" } as Record<number, string>)[e.authtype] ?? e.authtype,
      message_format: ({ 1: "BinaryXML", 2: "Json", 3: "TextXML" } as Record<number, string>)[e.messageformat] ?? e.messageformat,
    },
  };
}

async function handleRegisterWebhook(args: {
  name: string; url: string; auth_type?: number; auth_value?: string; message_format?: number;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    name: args.name,
    url: args.url,
    contract: 8, // Webhook
    authtype: args.auth_type ?? 5, // WebhookKey default
    messageformat: args.message_format ?? 2, // Json default
  };
  if (args.auth_value) data.authvalue = args.auth_value;

  return d365("serviceendpoints", "POST", data);
}

async function handleRegisterServiceBusEndpoint(args: {
  name: string; namespace_address: string; sas_key_name: string;
  sas_key: string; contract_type: number; path: string; message_format?: number;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    name: args.name,
    namespaceaddress: args.namespace_address,
    saskeyname: args.sas_key_name,
    saskey: args.sas_key,
    contract: args.contract_type,
    path: args.path,
    messageformat: args.message_format ?? 2, // Json default
    authtype: 1, // SASKey
  };

  return d365("serviceendpoints", "POST", data);
}

async function handleUpdateServiceEndpoint(args: {
  endpoint_id: string; name?: string; url?: string; auth_type?: number;
  auth_value?: string; message_format?: number;
}) {
  requireEnv();
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  if (args.url !== undefined) data.url = args.url;
  if (args.auth_type !== undefined) data.authtype = args.auth_type;
  if (args.auth_value !== undefined) data.authvalue = args.auth_value;
  if (args.message_format !== undefined) data.messageformat = args.message_format;

  return d365(`serviceendpoints(${args.endpoint_id})`, "PATCH", data);
}

async function handleDeleteServiceEndpoint(args: { endpoint_id: string }) {
  requireEnv();
  return d365(`serviceendpoints(${args.endpoint_id})`, "DELETE");
}

// ───────────────────────────── Organization Settings ─────────────────────────

async function handleGetOrgSettings() {
  requireEnv();
  return d365("organizations?$select=organizationid,name,friendlyname,plugintracelogsetting,version,schemaname");
}

async function handleSetPluginTraceSetting(args: { level: number }) {
  requireEnv();
  if (![0, 1, 2].includes(args.level)) throw new Error("Level must be 0 (Off), 1 (Exception), or 2 (All).");
  // Get org ID first
  const orgs = (await d365("organizations?$select=organizationid")) as { value: any[] };
  if (!orgs.value.length) throw new Error("Could not retrieve organization ID.");
  const orgId = orgs.value[0].organizationid;
  await d365(`organizations(${orgId})`, "PATCH", { plugintracelogsetting: args.level });
  const labels = { 0: "Off", 1: "Exception", 2: "All" };
  return { success: true, plugintracelogsetting: args.level, label: labels[args.level as keyof typeof labels] };
}

// ───────────────────────────── Web Resources ─────────────────────────────────

const TEXT_WR_TYPES = new Set([1, 2, 3, 4, 9, 12]); // HTML, CSS, JS, XML, XSL, RESX

async function handleListWebResources(args: { filter?: string; type?: number; top?: number }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`contains(name,'${args.filter.replace(/'/g, "''")}')`);
  if (args.type !== undefined) filters.push(`webresourcetype eq ${args.type}`);
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  const top = Math.min(args.top ?? 50, 200);
  return d365(
    `webresourceset?${fqs}$select=webresourceid,name,displayname,webresourcetype,description,ismanaged,modifiedon&$top=${top}&$orderby=name asc`
  );
}

async function handleGetWebResource(args: { web_resource_id: string }) {
  requireEnv();
  const wr = (await d365(
    `webresourceset(${args.web_resource_id})?$select=webresourceid,name,displayname,webresourcetype,content,description`
  )) as any;

  // Decode base64 content for text types
  if (wr.content && TEXT_WR_TYPES.has(wr.webresourcetype)) {
    try {
      wr.decoded_content = Buffer.from(wr.content, "base64").toString("utf-8");
    } catch { /* leave as base64 */ }
  }

  const typeLabels: Record<number, string> = {
    1: "HTML", 2: "CSS", 3: "JavaScript", 4: "XML", 5: "PNG", 6: "JPG",
    7: "GIF", 8: "Silverlight (XAP)", 9: "XSL", 10: "ICO", 11: "SVG", 12: "RESX",
  };
  wr.type_label = typeLabels[wr.webresourcetype] ?? `Unknown (${wr.webresourcetype})`;
  return wr;
}

async function handleUpdateWebResource(args: { web_resource_id: string; content: string; display_name?: string; description?: string }) {
  requireEnv();
  // Get the type to know if we need to base64 encode
  const existing = (await d365(
    `webresourceset(${args.web_resource_id})?$select=webresourcetype`
  )) as any;

  const data: Record<string, unknown> = {};
  if (TEXT_WR_TYPES.has(existing.webresourcetype)) {
    data.content = Buffer.from(args.content, "utf-8").toString("base64");
  } else {
    data.content = args.content; // Assume already base64 for binary types
  }
  if (args.display_name) data.displayname = args.display_name;
  if (args.description) data.description = args.description;

  return d365(`webresourceset(${args.web_resource_id})`, "PATCH", data);
}

async function handleCreateWebResource(args: {
  name: string; content: string; type: number; display_name?: string; description?: string; solution_unique_name?: string;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    name: args.name,
    webresourcetype: args.type,
    displayname: args.display_name ?? args.name,
  };

  if (TEXT_WR_TYPES.has(args.type)) {
    data.content = Buffer.from(args.content, "utf-8").toString("base64");
  } else {
    data.content = args.content;
  }
  if (args.description) data.description = args.description;

  const headers: Record<string, string> = {};
  if (args.solution_unique_name) {
    headers["MSCRM.SolutionUniqueName"] = args.solution_unique_name;
  }

  return d365("webresourceset", "POST", data, headers);
}

// ───────────────────────────── ALM Operations ────────────────────────────────

async function handlePublishCustomizations(args: { publish_all?: boolean; component_xml?: string }) {
  requireEnv();
  if (args.publish_all !== false) {
    // PublishAllXml
    return d365("PublishAllXml", "POST", {});
  } else if (args.component_xml) {
    // PublishXml with specific components
    return d365("PublishXml", "POST", { ParameterXml: args.component_xml });
  }
  throw new Error("Either publish_all: true or component_xml must be provided.");
}

async function handleExportSolution(args: { solution_unique_name: string; managed?: boolean }) {
  requireEnv();
  const result = (await d365("ExportSolution", "POST", {
    SolutionName: args.solution_unique_name,
    Managed: args.managed ?? false,
  })) as any;

  // The response contains ExportSolutionFile as base64
  const fileSize = result.ExportSolutionFile
    ? Math.round(result.ExportSolutionFile.length * 0.75 / 1024)
    : 0;

  return {
    solution_name: args.solution_unique_name,
    managed: args.managed ?? false,
    file_base64: result.ExportSolutionFile,
    file_size_kb: fileSize,
    note: "Use the base64 content with import_solution to import into another environment.",
  };
}

async function handleImportSolution(args: {
  solution_file_base64: string; overwrite_unmanaged?: boolean; publish_workflows?: boolean;
}) {
  requireEnv();
  return d365("ImportSolution", "POST", {
    CustomizationFile: args.solution_file_base64,
    OverwriteUnmanagedCustomizations: args.overwrite_unmanaged ?? true,
    PublishWorkflows: args.publish_workflows ?? true,
  });
}

// ───────────────────────────── Environment Variables ─────────────────────────

async function handleListEnvironmentVariables(args: { filter?: string }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) {
    filters.push(`(contains(schemaname,'${args.filter.replace(/'/g, "''")}') or contains(displayname,'${args.filter.replace(/'/g, "''")}'))`);
  }
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `environmentvariabledefinitions?${fqs}$select=environmentvariabledefinitionid,schemaname,displayname,description,type,defaultvalue,ismanaged&$expand=environmentvariablevalues($select=environmentvariablevalueid,value)&$orderby=schemaname asc`
  );
}

async function handleGetEnvironmentVariable(args: { schema_name: string }) {
  requireEnv();
  const defs = (await d365(
    `environmentvariabledefinitions?$filter=schemaname eq '${args.schema_name.replace(/'/g, "''")}'&$select=environmentvariabledefinitionid,schemaname,displayname,description,type,defaultvalue,ismanaged&$expand=environmentvariablevalues($select=environmentvariablevalueid,value)`
  )) as { value: any[] };

  if (!defs.value.length) throw new Error(`Environment variable '${args.schema_name}' not found.`);
  const def = defs.value[0];
  const currentValue = def.environmentvariablevalues?.length
    ? def.environmentvariablevalues[0].value
    : def.defaultvalue;

  return {
    ...def,
    current_value: currentValue,
    source: def.environmentvariablevalues?.length ? "EnvironmentVariableValue" : "DefaultValue",
  };
}

async function handleSetEnvironmentVariable(args: { definition_id: string; value: string }) {
  requireEnv();
  // Check if a value record already exists
  const existing = (await d365(
    `environmentvariablevalues?$filter=_environmentvariabledefinitionid_value eq ${args.definition_id}&$select=environmentvariablevalueid`
  )) as { value: any[] };

  if (existing.value.length) {
    // Update existing value
    return d365(`environmentvariablevalues(${existing.value[0].environmentvariablevalueid})`, "PATCH", {
      value: args.value,
    });
  } else {
    // Create new value record
    return d365("environmentvariablevalues", "POST", {
      value: args.value,
      "EnvironmentVariableDefinitionId@odata.bind": `/environmentvariabledefinitions(${args.definition_id})`,
    });
  }
}

// ───────────────────────────── Role Assignment ───────────────────────────────

async function handleAssignSecurityRole(args: { user_id: string; role_id: string }) {
  requireEnv();
  return d365(
    `systemusers(${args.user_id})/systemuserroles_association/$ref`, "POST",
    { "@odata.id": `${getBaseUrl()}/roles(${args.role_id})` }
  );
}

async function handleRemoveSecurityRole(args: { user_id: string; role_id: string }) {
  requireEnv();
  return d365(
    `systemusers(${args.user_id})/systemuserroles_association(${args.role_id})/$ref`, "DELETE"
  );
}

// ───────────────────────────── Audit History ─────────────────────────────────

async function handleGetAuditHistory(args: {
  record_id?: string; entity_logical_name?: string; user_id?: string;
  action?: number; top?: number; hours_back?: number; attribute_filter?: string;
}) {
  requireEnv();
  const top = Math.min(args.top ?? 50, 500);

  // If a specific record is provided, use the RetrieveRecordChangeHistory function
  if (args.record_id && args.entity_logical_name) {
    // Get entity metadata to resolve the object type code
    const entityMeta = (await d365(
      `EntityDefinitions(LogicalName='${args.entity_logical_name}')?$select=ObjectTypeCode`
    )) as any;

    const filters: string[] = [];
    filters.push(`_objectid_value eq ${args.record_id}`);
    filters.push(`objecttypecode eq '${args.entity_logical_name}'`);
    if (args.user_id) filters.push(`_userid_value eq ${args.user_id}`);
    if (args.action !== undefined) filters.push(`action eq ${args.action}`);
    if (args.hours_back) {
      const cutoff = new Date(Date.now() - args.hours_back * 60 * 60 * 1000).toISOString();
      filters.push(`createdon ge ${cutoff}`);
    }

    const result = (await d365(
      `audits?$filter=${filters.join(" and ")}&$select=auditid,createdon,action,operation,objecttypecode,_objectid_value,_userid_value,changedata,attributemask&$orderby=createdon desc&$top=${top}`
    )) as { value: any[] };

    // Enrich with change details by fetching audit details for each record
    const enrichedResults = await Promise.allSettled(
      result.value.slice(0, 20).map(async (audit: any) => {
        try {
          const detail = (await d365(
            `RetrieveAuditDetails(AuditId=${audit.auditid})`
          )) as any;
          return {
            ...audit,
            action_label: { 1: "Create", 2: "Update", 3: "Delete", 12: "Upsert" }[audit.action as number] ?? audit.action,
            audit_detail: detail.AuditDetail,
          };
        } catch {
          return {
            ...audit,
            action_label: { 1: "Create", 2: "Update", 3: "Delete", 12: "Upsert" }[audit.action as number] ?? audit.action,
          };
        }
      })
    );

    const enriched = enrichedResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    // Filter by attribute if specified
    if (args.attribute_filter) {
      const targetAttrs = new Set(args.attribute_filter.split(",").map((a) => a.trim().toLowerCase()));
      return {
        value: enriched.filter((a: any) => {
          if (!a.audit_detail?.NewValue?.Attributes) return true;
          const changedAttrs = a.audit_detail.NewValue.Attributes.map((attr: any) =>
            (attr.key || attr.Key || "").toLowerCase()
          );
          return changedAttrs.some((ca: string) => targetAttrs.has(ca));
        }),
        total_unfiltered: enriched.length,
        attribute_filter: args.attribute_filter,
      };
    }

    return { value: enriched, record_id: args.record_id, entity: args.entity_logical_name };
  }

  // General audit query (no specific record)
  const filters: string[] = [];
  if (args.entity_logical_name) filters.push(`objecttypecode eq '${args.entity_logical_name}'`);
  if (args.user_id) filters.push(`_userid_value eq ${args.user_id}`);
  if (args.action !== undefined) filters.push(`action eq ${args.action}`);
  if (args.hours_back) {
    const cutoff = new Date(Date.now() - args.hours_back * 60 * 60 * 1000).toISOString();
    filters.push(`createdon ge ${cutoff}`);
  }

  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `audits?${fqs}$select=auditid,createdon,action,operation,objecttypecode,_objectid_value,_userid_value,changedata&$orderby=createdon desc&$top=${top}`
  );
}

async function handleGetEntityAuditStatus(args: { entity_logical_name: string }) {
  requireEnv();
  const meta = (await d365(
    `EntityDefinitions(LogicalName='${args.entity_logical_name}')?$select=LogicalName,DisplayName,IsAuditEnabled,IsCustomEntity`
  )) as any;

  return {
    entity: meta.LogicalName,
    display_name: meta.DisplayName?.UserLocalizedLabel?.Label ?? meta.LogicalName,
    is_audit_enabled: meta.IsAuditEnabled?.Value ?? false,
    is_custom_entity: meta.IsCustomEntity,
    note: meta.IsAuditEnabled?.Value
      ? "Auditing is ENABLED on this entity. Individual field auditing can be checked with get_field_audit_status."
      : "Auditing is DISABLED on this entity. Enable it in the entity settings or via metadata update.",
  };
}

async function handleGetFieldAuditStatus(args: { entity_logical_name: string; fields?: string }) {
  requireEnv();
  const attrs = (await d365(
    `EntityDefinitions(LogicalName='${args.entity_logical_name}')/Attributes?$select=LogicalName,DisplayName,IsAuditEnabled,AttributeType`
  )) as { value: any[] };

  let filtered = attrs.value;
  if (args.fields) {
    const targetFields = new Set(args.fields.split(",").map((f) => f.trim().toLowerCase()));
    filtered = attrs.value.filter((a: any) => targetFields.has(a.LogicalName.toLowerCase()));
  }

  const result = filtered.map((a: any) => ({
    logical_name: a.LogicalName,
    display_name: a.DisplayName?.UserLocalizedLabel?.Label ?? a.LogicalName,
    attribute_type: a.AttributeType,
    is_audit_enabled: a.IsAuditEnabled?.Value ?? false,
  }));

  const auditedCount = result.filter((r: any) => r.is_audit_enabled).length;

  return {
    entity: args.entity_logical_name,
    total_fields: result.length,
    audited_fields: auditedCount,
    not_audited_fields: result.length - auditedCount,
    fields: result,
  };
}

async function handleGetOrgAuditStatus() {
  requireEnv();
  const orgs = (await d365(
    "organizations?$select=organizationid,name,isauditenabled,auditretentionperiodv2,isuseraccessauditenabled"
  )) as { value: any[] };

  if (!orgs.value.length) throw new Error("Could not retrieve organization settings.");
  const org = orgs.value[0];

  return {
    organization: org.name,
    is_audit_enabled: org.isauditenabled,
    audit_retention_period_days: org.auditretentionperiodv2 ?? "Not set",
    is_user_access_audit_enabled: org.isuseraccessauditenabled,
    note: org.isauditenabled
      ? "Organization-level auditing is ENABLED. Individual entities and fields may still need auditing turned on."
      : "Organization-level auditing is DISABLED. No audit records are being captured. Enable it in Settings → Auditing.",
  };
}

// ───────────────────────────── Managed Identity ──────────────────────────────

async function handleListManagedIdentities(args: { filter?: string }) {
  requireEnv();
  const filters: string[] = [];
  if (args.filter) filters.push(`contains(applicationid,'${args.filter.replace(/'/g, "''")}')`);
  const fqs = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  return d365(
    `managedidentities?${fqs}$select=managedidentityid,applicationid,tenantid,credentialsource,subjectscope,version,createdon,modifiedon&$orderby=createdon desc`
  );
}

async function handleCreateManagedIdentity(args: {
  application_id: string; managed_identity_id: string; tenant_id: string;
  credential_source?: number; subject_scope?: number;
}) {
  requireEnv();
  const data: Record<string, unknown> = {
    applicationid: args.application_id,
    managedidentityid: args.managed_identity_id,
    credentialsource: args.credential_source ?? 2, // Federated
    subjectscope: args.subject_scope ?? 1, // Environment
    tenantid: args.tenant_id,
    version: 1,
  };
  return d365("managedidentities", "POST", data);
}

async function handleAssociateAssemblyManagedIdentity(args: { assembly_id: string; managed_identity_id: string }) {
  requireEnv();
  return d365(`pluginassemblies(${args.assembly_id})`, "PATCH", {
    "managedidentityid@odata.bind": `/managedidentities(${args.managed_identity_id})`,
  });
}

/**
 * Compute the federated identity credential subject for a Dataverse environment.
 * Format: /eid1/c/pub/t/{encodedTenantId}/a/{encodedAppId}/n/plugin/e/{environmentId}/h/{certHashHex}
 *
 * encodedTenantId / encodedAppId: GUID bytes → Base64URL (no padding, +→-, /→_)
 */
function handleComputeFederatedCredentialSubject(args: {
  tenant_id: string; application_id: string; environment_id: string; cert_hash_hex: string;
}) {
  // Convert GUID string to bytes (little-endian groups like .NET)
  function guidToBytes(guid: string): Buffer {
    const hex = guid.replace(/-/g, "");
    // .NET GUID byte order: first 3 groups reversed, last 2 groups as-is
    const parts = guid.split("-");
    const reordered =
      parts[0].match(/.{2}/g)!.reverse().join("") +
      parts[1].match(/.{2}/g)!.reverse().join("") +
      parts[2].match(/.{2}/g)!.reverse().join("") +
      parts[3] +
      parts[4];
    return Buffer.from(reordered, "hex");
  }

  function base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const encodedTenantId = base64url(guidToBytes(args.tenant_id));
  const encodedAppId = base64url(guidToBytes(args.application_id));
  const certHashHex = args.cert_hash_hex.toLowerCase().replace(/[^0-9a-f]/g, "");

  const subject = `/eid1/c/pub/t/${encodedTenantId}/a/${encodedAppId}/n/plugin/e/${args.environment_id}/h/${certHashHex}`;

  return {
    subject,
    issuer: `https://login.microsoftonline.com/${args.tenant_id}/v2.0`,
    audience: "api://AzureADTokenExchange",
    note: "Use these values when creating the federated identity credential on the UAMI in Azure.",
    az_cli_command: `az identity federated-credential create --identity-name "YOUR_UAMI_NAME" --resource-group "YOUR_RG" --name "dataverse-credential" --issuer "https://login.microsoftonline.com/${args.tenant_id}/v2.0" --subject "${subject}" --audiences "api://AzureADTokenExchange"`,
    inputs: {
      tenant_id: args.tenant_id,
      application_id: args.application_id,
      environment_id: args.environment_id,
      cert_hash_hex: certHashHex,
      encoded_tenant_id: encodedTenantId,
      encoded_app_id: encodedAppId,
    },
  };
}

// ───────────────────────────── Batch Operations ──────────────────────────────

async function handleExecuteBatch(args: { requests: Array<{ method: string; url: string; body?: unknown }> }) {
  requireEnv();
  return d365Batch(args.requests);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POWER AUTOMATE (CLOUD FLOWS)
// ═══════════════════════════════════════════════════════════════════════════════

/** Escape a value for a single-quoted OData string literal (`'` → `''`). */
function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

// Pure logic for Power Automate cloud flows stored in Dataverse — no I/O here, so all of it
// is unit-testable. `handlers/flows.ts` does the talking to Dataverse.
//
// A cloud flow is a `workflow` row with category 5 ("Modern Flow"). Its whole definition
// lives in `clientdata`, a JSON *string*:
//
//   { "properties": { "connectionReferences": {...}, "definition": {Logic Apps template} },
//     "schemaVersion": "1.0.0.0" }
//
// Everything below was established against a live Dataverse org with throwaway flows. The two
// facts that shape the design:
//
//  1. Dataverse validates very little at create/update time — only that clientdata parses,
//     has `schemaVersion`, and that every connection reference logical name exists. The
//     Logic Apps template (runAfter targets, expressions, connector wiring) is validated only
//     when the flow is turned ON. A Draft flow therefore stores a broken definition silently.
//  2. "Activated" is not the same as "will fire". A Dataverse-triggered flow whose trigger
//     parameters are wrong (e.g. filteringattributes on a Create-only trigger) activates with
//     a 204 and then never registers its webhook. The only Dataverse-side evidence is the
//     absence of a live `callbackregistration` named after the workflowid.
//
// So the lint here catches what activation would reject, with an error that names the cause,
// plus the trigger mistakes activation does *not* reject at all.

const FLOW_CATEGORY = 5;
const DATAVERSE_API = "shared_commondataserviceforapps";
const SCHEMA_URL =
  "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a GUID before it goes into an OData path or filter. */
function assertGuid(value: unknown, label: string): string {
  const v = typeof value === "string" ? value.trim().replace(/^\{|\}$/g, "") : "";
  if (!GUID_RE.test(v)) throw new Error(`INVALID_ID: ${label} must be a GUID, got ${JSON.stringify(value)}.`);
  return v.toLowerCase();
}

function isGuid(value: unknown): boolean {
  return typeof value === "string" && GUID_RE.test(value.trim());
}

/** workflow.modernflowtype */
const MODERN_FLOW_TYPES: Record<number, string> = {
  0: "Power Automate",
  1: "Copilot Studio agent flow",
  2: "M365 Copilot agent flow",
};

/** SubscribeWebhookTrigger `subscriptionRequest/message` — the Dataverse "Change type" dropdown. */
const DATAVERSE_TRIGGER_MESSAGES: Record<number, string> = {
  1: "Added",
  2: "Deleted",
  3: "Modified",
  4: "Added or Modified",
  5: "Added or Deleted",
  6: "Modified or Deleted",
  7: "Added or Modified or Deleted",
};
/** Messages that include an Update — the only ones Dataverse lets carry filteringattributes. */
const MESSAGES_WITH_UPDATE = new Set([3, 4, 6, 7]);

/** SubscribeWebhookTrigger `subscriptionRequest/scope`. */
const DATAVERSE_TRIGGER_SCOPES: Record<number, string> = {
  1: "User",
  2: "Business Unit",
  3: "Parent: Child Business Unit",
  4: "Organization",
};

type Json = Record<string, any>;

interface ConnectionReferenceEntry {
  runtimeSource?: string;
  connection?: { connectionReferenceLogicalName?: string; name?: string };
  api?: { name?: string };
  [k: string]: unknown;
}

interface ClientData {
  properties: {
    connectionReferences: Record<string, ConnectionReferenceEntry>;
    definition: Json;
    [k: string]: unknown;
  };
  schemaVersion: string;
}

interface LintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

// ─── Parsing & normalization ──────────────────────────────────────────────────

/** Parse a workflow row's clientdata. Returns null for an empty or unparseable value. */
function parseClientData(raw: unknown): ClientData | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    parsed.properties ??= {};
    parsed.properties.connectionReferences ??= {};
    parsed.properties.definition ??= {};
    return parsed as ClientData;
  } catch {
    return null;
  }
}

/** Accept an object, or a JSON string of one (some clients stringify object arguments). */
function coerceObject(value: unknown, label: string): Json | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through to the error below */ }
    throw new Error(`INVALID_ARGUMENT: ${label} must be a JSON object.`);
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_ARGUMENT: ${label} must be a JSON object.`);
  return value as Json;
}

/**
 * Callers hand us one of three shapes, because get_cloud_flow returns the parts separately
 * and the portal's "Peek code" / exported definition.json use the others:
 *   - the Logic Apps definition itself            { triggers, actions, ... }
 *   - the `properties` object                      { definition, connectionReferences }
 *   - a whole clientdata                           { properties: { definition, ... }, schemaVersion }
 * Returns the definition and any connection references that came embedded with it.
 */
function splitDefinitionInput(input: Json): { definition: Json; connectionReferences?: Record<string, ConnectionReferenceEntry> } {
  if (input.properties && typeof input.properties === "object" && input.properties.definition) {
    return { definition: input.properties.definition, connectionReferences: input.properties.connectionReferences };
  }
  if (input.definition && typeof input.definition === "object" && (input.definition.triggers || input.definition.actions)) {
    return { definition: input.definition, connectionReferences: input.connectionReferences };
  }
  return { definition: input };
}

/**
 * Fill in the boilerplate the designer always writes. Omitting `$authentication` while an
 * action uses `@parameters('$authentication')` is not caught at save — activation then fails
 * with an opaque 500 NullReferenceException — so both parameters are always declared.
 * Returns what was added so the caller can report it.
 */
function normalizeDefinition(definition: Json): { definition: Json; added: string[] } {
  const def: Json = { ...definition };
  const added: string[] = [];
  if (!def.$schema) { def.$schema = SCHEMA_URL; added.push("$schema"); }
  if (!def.contentVersion) { def.contentVersion = "1.0.0.0"; added.push("contentVersion"); }
  const params: Json = { ...(def.parameters ?? {}) };
  if (!params.$connections) { params.$connections = { defaultValue: {}, type: "Object" }; added.push("parameters.$connections"); }
  if (!params.$authentication) { params.$authentication = { defaultValue: {}, type: "SecureObject" }; added.push("parameters.$authentication"); }
  def.parameters = params;
  def.triggers ??= {};
  def.actions ??= {};
  return { definition: def, added };
}

/**
 * Build one connectionReferences entry from a connection reference logical name. This is
 * the exact shape the designer writes for a solution-aware flow; `runtimeSource: embedded`
 * means the flow runs with the connection bound to the reference, not the invoker's.
 */
function connectionReferenceEntry(logicalName: string, apiName: string): ConnectionReferenceEntry {
  return {
    runtimeSource: "embedded",
    connection: { connectionReferenceLogicalName: logicalName },
    api: { name: apiName },
  };
}

/** `/providers/Microsoft.PowerApps/apis/shared_x` → `shared_x`. */
function apiNameFromConnectorId(connectorId: string | null | undefined): string {
  if (!connectorId) return "";
  const parts = connectorId.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function buildClientData(definition: Json, connectionReferences: Record<string, ConnectionReferenceEntry>): ClientData {
  return { properties: { connectionReferences, definition }, schemaVersion: "1.0.0.0" };
}

// ─── Walking the template ─────────────────────────────────────────────────────

interface ActionVisit {
  name: string;
  action: Json;
  /** Dotted location, e.g. `actions.Scope.actions.Get_row`. */
  path: string;
  /** Names of the actions that share this action's container — what runAfter may reference. */
  siblings: Set<string>;
  depth: number;
}

/** Every container of child actions an action can hold: If/Scope/Foreach/Until and Switch. */
function childContainers(action: Json, path: string): Array<{ actions: Json; path: string }> {
  const out: Array<{ actions: Json; path: string }> = [];
  if (action.actions && typeof action.actions === "object") out.push({ actions: action.actions, path: `${path}.actions` });
  if (action.else?.actions && typeof action.else.actions === "object") out.push({ actions: action.else.actions, path: `${path}.else.actions` });
  if (action.default?.actions && typeof action.default.actions === "object") out.push({ actions: action.default.actions, path: `${path}.default.actions` });
  for (const [caseName, c] of Object.entries((action.cases ?? {}) as Json)) {
    if (c?.actions && typeof c.actions === "object") out.push({ actions: c.actions, path: `${path}.cases.${caseName}.actions` });
  }
  return out;
}

function walkActions(actions: Json | undefined, visit: (v: ActionVisit) => void, path = "actions", depth = 0): void {
  if (!actions || typeof actions !== "object") return;
  const siblings = new Set(Object.keys(actions));
  for (const [name, action] of Object.entries(actions)) {
    if (!action || typeof action !== "object") continue;
    const here = `${path}.${name}`;
    visit({ name, action, path: here, siblings, depth });
    for (const child of childContainers(action, here)) walkActions(child.actions, visit, child.path, depth + 1);
  }
}

const CONNECTOR_TYPES = new Set(["OpenApiConnection", "OpenApiConnectionWebhook", "OpenApiConnectionNotification", "ApiConnection", "ApiConnectionWebhook"]);

function isConnectorOperation(node: Json): boolean {
  return CONNECTOR_TYPES.has(node.type) && typeof node.inputs === "object" && node.inputs !== null;
}

/** Visit every string value under `node`, with its path. */
function walkStrings(node: unknown, path: string, visit: (s: string, path: string) => void): void {
  if (typeof node === "string") { visit(node, path); return; }
  if (Array.isArray(node)) { node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit)); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}.${k}`, visit);
  }
}

/** True when a `@{` string-interpolation segment is never closed. `@@{` is an escaped literal. */
function hasUnterminatedInterpolation(s: string): boolean {
  let i = s.indexOf("@{");
  while (i !== -1) {
    const escaped = i > 0 && s[i - 1] === "@";
    if (!escaped && s.indexOf("}", i + 2) === -1) return true;
    i = s.indexOf("@{", i + 2);
  }
  return false;
}

// ─── Lint ─────────────────────────────────────────────────────────────────────

/**
 * Static checks on a definition + its connectionReferences. Errors are things activation is
 * known to reject (or that silently break the trigger); warnings are things worth a look.
 * Deliberately conservative — a false "error" would block a valid flow.
 */
function lintFlow(definition: Json, connectionReferences: Record<string, ConnectionReferenceEntry>): LintIssue[] {
  const issues: LintIssue[] = [];
  const err = (code: string, message: string, path?: string) => issues.push({ severity: "error", code, message, path });
  const warn = (code: string, message: string, path?: string) => issues.push({ severity: "warning", code, message, path });

  const triggers = definition.triggers;
  const triggerNames = triggers && typeof triggers === "object" ? Object.keys(triggers) : [];
  if (triggerNames.length === 0) err("NO_TRIGGER", "The definition has no trigger. A cloud flow needs exactly one entry under `triggers`.", "triggers");
  if (triggerNames.length > 1) err("MULTIPLE_TRIGGERS", `Cloud flows support exactly one trigger; found ${triggerNames.length}: ${triggerNames.join(", ")}.`, "triggers");
  if (!definition.actions || Object.keys(definition.actions).length === 0) {
    warn("NO_ACTIONS", "The definition has no actions. The flow will run its trigger and do nothing.", "actions");
  }

  const refKeys = new Set(Object.keys(connectionReferences ?? {}));
  const usedKeys = new Set<string>();

  const checkConnectorOp = (node: Json, path: string) => {
    const host = node.inputs?.host ?? {};
    const key = host.connectionName ?? host.connectionReferenceName;
    if (!key) {
      err("MISSING_CONNECTION_NAME", `Connector operation has no inputs.host.connectionName. Set it to a key of connectionReferences (${[...refKeys].join(", ") || "none declared"}).`, path);
      return;
    }
    usedKeys.add(key);
    if (!refKeys.has(key)) {
      // Activation reports this misleadingly — as "should not have the property 'authentication'"
      // or "host.connectionReferenceName is missing" — so name the real cause here.
      err(
        "UNDECLARED_CONNECTION",
        `inputs.host.connectionName "${key}" is not a key of connectionReferences (` +
        `${[...refKeys].join(", ") || "none declared"}). Pass connection_references: { "${key}": "<connection reference logical name>" } — ` +
        "find one with list_connection_references.",
        path,
      );
    }
    if (!host.operationId) err("MISSING_OPERATION_ID", "Connector operation has no inputs.host.operationId.", path);
    if (host.operationId === "SubscribeWebhookTrigger") lintDataverseTrigger(node, path, err, warn);
  };

  for (const name of triggerNames) {
    const t = triggers[name];
    if (t && isConnectorOperation(t)) checkConnectorOp(t, `triggers.${name}`);
  }

  walkActions(definition.actions, ({ name, action, path, siblings }) => {
    for (const dep of Object.keys(action.runAfter ?? {})) {
      if (!siblings.has(dep)) {
        err("BAD_RUN_AFTER", `"${name}" runs after "${dep}", which is not an action in the same scope. runAfter may only name siblings.`, `${path}.runAfter`);
      }
    }
    if (runsAfterItself(action, name)) err("BAD_RUN_AFTER", `"${name}" runs after itself.`, `${path}.runAfter`);
    if (isConnectorOperation(action)) checkConnectorOp(action, path);
    if (action.type === "Workflow" && !isGuid(action.inputs?.host?.workflowReferenceName)) {
      warn("CHILD_FLOW_REFERENCE", `Child-flow action "${name}" should set inputs.host.workflowReferenceName to the child flow's workflowid (a GUID).`, path);
    }
  });

  walkStrings({ triggers: definition.triggers, actions: definition.actions }, "", (s, path) => {
    if (hasUnterminatedInterpolation(s)) {
      err("UNTERMINATED_EXPRESSION", `String contains "@{" with no closing "}": ${s.length > 80 ? `${s.slice(0, 80)}…` : s}`, path.replace(/^\./, ""));
    }
  });

  for (const [key, entry] of Object.entries(connectionReferences ?? {})) {
    const logical = entry?.connection?.connectionReferenceLogicalName;
    if (!logical) {
      warn("NO_CONNECTION_REFERENCE_NAME", `connectionReferences.${key} has no connection.connectionReferenceLogicalName, so it is not bound through a connection reference. Solution-aware flows should use one.`, `connectionReferences.${key}`);
    }
    if (!usedKeys.has(key)) warn("UNUSED_CONNECTION_REFERENCE", `connectionReferences.${key} is declared but no trigger or action uses it.`, `connectionReferences.${key}`);
  }

  return issues;
}

function runsAfterItself(action: Json, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(action.runAfter ?? {}, name);
}

function lintDataverseTrigger(
  trigger: Json,
  path: string,
  err: (code: string, message: string, path?: string) => void,
  warn: (code: string, message: string, path?: string) => void,
): void {
  const p = trigger.inputs?.parameters ?? {};
  const message = Number(p["subscriptionRequest/message"]);
  const scope = p["subscriptionRequest/scope"];
  if (!p["subscriptionRequest/entityname"]) err("DATAVERSE_TRIGGER_NO_TABLE", "Dataverse trigger has no subscriptionRequest/entityname (the table logical name).", path);
  if (!DATAVERSE_TRIGGER_MESSAGES[message]) {
    err("DATAVERSE_TRIGGER_BAD_MESSAGE", `subscriptionRequest/message must be 1-7 (${Object.entries(DATAVERSE_TRIGGER_MESSAGES).map(([k, v]) => `${k}=${v}`).join(", ")}).`, path);
  }
  if (scope !== undefined && !DATAVERSE_TRIGGER_SCOPES[Number(scope)]) {
    err("DATAVERSE_TRIGGER_BAD_SCOPE", "subscriptionRequest/scope must be 1=User, 2=Business Unit, 3=Parent: Child Business Unit, or 4=Organization.", path);
  }
  if (scope === undefined) warn("DATAVERSE_TRIGGER_NO_SCOPE", "subscriptionRequest/scope is not set; the designer always writes it (4 = Organization fires for every row).", path);
  if (p["subscriptionRequest/filteringattributes"] && DATAVERSE_TRIGGER_MESSAGES[message] && !MESSAGES_WITH_UPDATE.has(message)) {
    // Verified against a live org: this saves AND activates fine, then the webhook registration fails with
    // 0x80040203 "To use FilteringAttributes, your trigger must include an Update event" — the
    // flow shows as On and never fires.
    err(
      "DATAVERSE_TRIGGER_FILTER_WITHOUT_UPDATE",
      `filteringattributes is only valid when the change type includes Modified (message 3, 4, 6 or 7); this trigger is ${DATAVERSE_TRIGGER_MESSAGES[message]} (${message}). ` +
      "It would turn On and silently never register.",
      path,
    );
  }
}

// ─── Summaries ────────────────────────────────────────────────────────────────

interface TriggerSummary {
  name: string;
  type: string;
  kind?: string;
  connector?: string;
  operation?: string;
  dataverse?: { table: string; change: string; scope?: string; filtering_attributes?: string; filter_expression?: string };
  recurrence?: Json;
}

function summarizeTrigger(definition: Json): TriggerSummary | null {
  const entries = Object.entries((definition?.triggers ?? {}) as Json);
  if (entries.length === 0) return null;
  const [name, t] = entries[0]!;
  const host = t?.inputs?.host ?? {};
  const summary: TriggerSummary = { name, type: t?.type };
  if (t?.kind) summary.kind = t.kind;
  if (host.apiId) summary.connector = apiNameFromConnectorId(host.apiId);
  if (host.operationId) summary.operation = host.operationId;
  if (host.operationId === "SubscribeWebhookTrigger") {
    const p = t.inputs.parameters ?? {};
    const message = Number(p["subscriptionRequest/message"]);
    summary.dataverse = {
      table: p["subscriptionRequest/entityname"],
      change: DATAVERSE_TRIGGER_MESSAGES[message] ? `${DATAVERSE_TRIGGER_MESSAGES[message]} (${message})` : String(p["subscriptionRequest/message"]),
      ...(p["subscriptionRequest/scope"] !== undefined ? { scope: DATAVERSE_TRIGGER_SCOPES[Number(p["subscriptionRequest/scope"])] ?? String(p["subscriptionRequest/scope"]) } : {}),
      ...(p["subscriptionRequest/filteringattributes"] ? { filtering_attributes: p["subscriptionRequest/filteringattributes"] } : {}),
      ...(p["subscriptionRequest/filterexpression"] ? { filter_expression: p["subscriptionRequest/filterexpression"] } : {}),
    };
  }
  if (t?.recurrence) summary.recurrence = t.recurrence;
  return summary;
}

/** True when this flow's trigger is a Dataverse row webhook, which registers a callbackregistration. */
function hasDataverseWebhookTrigger(definition: Json): boolean {
  return summarizeTrigger(definition)?.operation === "SubscribeWebhookTrigger";
}

interface ActionOutline {
  total: number;
  /** Top-level actions in order, with nested counts — enough to orient before reading the JSON. */
  top_level: Array<{ name: string; type: string; operation?: string; nested?: number }>;
  connectors_used: string[];
  child_flows: string[];
}

function outlineActions(definition: Json): ActionOutline {
  let total = 0;
  const connectors = new Set<string>();
  const childFlows = new Set<string>();
  const nestedCount = new Map<string, number>();
  walkActions(definition?.actions, ({ action, path, depth }) => {
    total++;
    if (depth > 0) {
      const top = path.split(".")[1]!;
      nestedCount.set(top, (nestedCount.get(top) ?? 0) + 1);
    }
    const apiId = action.inputs?.host?.apiId;
    if (apiId) connectors.add(apiNameFromConnectorId(apiId));
    if (action.type === "Workflow" && action.inputs?.host?.workflowReferenceName) childFlows.add(action.inputs.host.workflowReferenceName);
  });
  const top_level = Object.entries((definition?.actions ?? {}) as Json).map(([name, a]) => ({
    name,
    type: a?.type,
    ...(a?.inputs?.host?.operationId ? { operation: a.inputs.host.operationId } : {}),
    ...(nestedCount.get(name) ? { nested: nestedCount.get(name) } : {}),
  }));
  return { total, top_level, connectors_used: [...connectors].sort(), child_flows: [...childFlows] };
}

/** Connection reference logical names a clientdata depends on. */
function connectionReferenceNames(connectionReferences: Record<string, ConnectionReferenceEntry>): string[] {
  const out = new Set<string>();
  for (const entry of Object.values(connectionReferences ?? {})) {
    const n = entry?.connection?.connectionReferenceLogicalName;
    if (n) out.add(n);
  }
  return [...out];
}

// ─── Error interpretation ─────────────────────────────────────────────────────

/**
 * Turn an activation/update failure into a cause and a fix. The Flow service's messages are
 * accurate about *what* failed and often wrong about *why* — every mapping below is a message
 * reproduced against a live org whose literal text sends you the wrong way.
 */
function explainFlowError(message: string): { cause: string; fix: string } | null {
  const m = message;
  if (/Cannot find connection with name/i.test(m) || /ConnectionNotFound/i.test(m)) {
    return {
      cause: "CONNECTION_NOT_ACCESSIBLE — a connection reference is bound to a connection that is not shared with you (or was deleted). The connection exists; you just cannot use it.",
      fix: "Ask the connection's owner to share it with you, or rebind the connection reference to a connection you own (update_connection_reference), then turn the flow on again.",
    };
  }
  if (/need connections created/i.test(m)) {
    return {
      cause: "UNBOUND_CONNECTION_REFERENCE — a connection reference the flow uses has no connection.",
      fix: "Bind it (update_connection_reference with connection_id, or in the maker portal under Solutions → Connection references), then turn the flow on.",
    };
  }
  if (/should not have the property 'authentication'/i.test(m) || /host\.connectionReferenceName' is missing/i.test(m)) {
    return {
      cause: "UNDECLARED_CONNECTION — an action's inputs.host.connectionName does not match any key in connectionReferences (the 'authentication' wording is a red herring).",
      fix: "Make every connector action's host.connectionName equal a connectionReferences key. Run validate_cloud_flow to list them.",
    };
  }
  if (/NullReferenceException/i.test(m)) {
    return {
      cause: "Usually a connector action uses @parameters('$authentication') while the definition does not declare the $authentication parameter, or a connectionReferences entry is malformed.",
      fix: "Declare parameters.$authentication ({type: SecureObject, defaultValue: {}}) and $connections ({type: Object, defaultValue: {}}); create/update_cloud_flow add them automatically.",
    };
  }
  if (/TemplateValidationError/i.test(m)) {
    return { cause: "The Logic Apps template is invalid — the message names the action and the problem.", fix: "Fix the named action (runAfter target, expression syntax) and retry. validate_cloud_flow catches most of these without a write." };
  }
  if (/ConnectionReferenceNotFound|Failed to find connection references/i.test(m)) {
    return { cause: "A connection reference logical name in the flow does not exist in this environment.", fix: "Create it (create_connection_reference) or use an existing one (list_connection_references)." };
  }
  if (/DLP|Data Loss Prevention|CompanyDLPViolation/i.test(m)) {
    return { cause: "A data loss prevention policy forbids this combination of connectors in this environment.", fix: "Change the connectors or ask a Power Platform admin about the policy. Not fixable from Dataverse." };
  }
  if (/412|Precondition Failed/i.test(m)) {
    return { cause: "The flow changed since you read it (someone saved it in the designer, or another call).", fix: "Re-read it with get_cloud_flow, re-apply your edit to the new definition, and pass the new version." };
  }
  return null;
}

/**
 * Pull the human message out of a `D365 400: {json}` error. Flow-service failures arrive as
 * JSON nested inside strings several layers deep, so the backslash runs are collapsed too.
 */
function dataverseErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  let message = text;
  const brace = text.indexOf("{");
  if (brace !== -1) {
    try {
      message = JSON.parse(text.slice(brace))?.error?.message ?? text;
    } catch { /* not JSON — keep the raw text */ }
  }
  return message.replace(/\\+"/g, '"');
}

// ───────────────────────────── Power Automate (cloud flows) ───────────────────
//
// Cloud flows are Dataverse `workflow` rows (category 5); run history is the `flowrun`
// elastic table; connectors bind through `connectionreference` rows. Everything here goes
// through the Dataverse Web API only, with the same Dataverse token as every other tool.

/** Poll cadence for a Dataverse trigger's webhook registration. Mutable so tests run instantly. */
const flowTiming = { registrationPollMs: 3000, registrationAttempts: 6 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FLOW_SELECT =
  "workflowid,name,description,category,statecode,statuscode,modernflowtype,ismanaged," +
  "createdon,modifiedon,_ownerid_value,_modifiedby_value,versionnumber";

const CONNREF_SELECT =
  "connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid," +
  "connectionid,_ownerid_value,ismanaged,statecode,description,modifiedon";

const STATE_LABELS: Record<number, string> = { 0: "Off", 1: "On", 2: "Suspended" };
const FLOW_TYPE_FILTERS: Record<string, number> = { power_automate: 0, copilot_studio: 1, m365_agent: 2 };
const RUN_STATUSES = new Set(["Succeeded", "Failed", "Cancelled"]);
const MAX_RESTARTS_PER_CALL = 3;
/** Connectors whose operations run over another connector's connection (AI Builder prompts run over the Dataverse connection). */
const RIDES_ON: Record<string, string> = { aibuilder: DATAVERSE_API };

const formatted = (row: Json, field: string): string | undefined =>
  row[`${field}@OData.Community.Display.V1.FormattedValue`];

function summarizeFlowRow(row: Json): Json {
  return {
    id: row.workflowid,
    name: row.name,
    state: STATE_LABELS[row.statecode] ?? String(row.statecode),
    status: formatted(row, "statuscode") ?? row.statuscode,
    type: MODERN_FLOW_TYPES[row.modernflowtype] ?? row.modernflowtype,
    managed: row.ismanaged,
    owner: formatted(row, "_ownerid_value") ?? row._ownerid_value,
    owner_id: row._ownerid_value,
    modified_on: row.modifiedon,
    ...(row.description ? { description: row.description } : {}),
  };
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

/** Power Platform environment id per org — needed for maker-portal links. Org metadata, not caller state. */
const environmentIds = new Map<string, string | null>();

async function environmentId(): Promise<string | null> {
  const url = activeEnvironment!.url;
  if (environmentIds.has(url)) return environmentIds.get(url)!;
  let id: string | null = null;
  try {
    const org = (await d365("RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')")) as Json;
    id = org?.Detail?.EnvironmentId ?? org?.EnvironmentId ?? null;
  } catch {
    id = null; // a missing link is not worth failing the tool over
  }
  environmentIds.set(url, id);
  return id;
}

function flowPortalUrl(envId: string | null, flowId: string): string | undefined {
  return envId ? `https://make.powerautomate.com/environments/${envId}/flows/${flowId}/details` : undefined;
}

async function getFlowRow(flowId: string, extraSelect = ""): Promise<Json> {
  const id = assertGuid(flowId, "flow_id");
  const row = (await d365(`workflows(${id})?$select=${FLOW_SELECT}${extraSelect ? `,${extraSelect}` : ""}`)) as Json;
  if (row.category !== FLOW_CATEGORY) {
    throw new Error(
      `NOT_A_CLOUD_FLOW: workflow ${id} ("${row.name}") has category ${row.category}` +
      `${formatted(row, "category") ? ` (${formatted(row, "category")})` : ""}, not 5 (Modern Flow). These tools manage Power Automate cloud flows only.`,
    );
  }
  return row;
}

async function resolveFlowId(args: { flow_id?: string; name?: string }): Promise<string> {
  if (args.flow_id) return assertGuid(args.flow_id, "flow_id");
  if (!args.name) throw new Error("INVALID_ARGUMENT: pass flow_id (preferred) or the flow's exact name.");
  const res = (await d365(
    `workflows?$filter=category eq ${FLOW_CATEGORY} and name eq '${escapeODataString(args.name)}'&$select=workflowid,name,statecode,ismanaged`,
  )) as Json;
  const rows: Json[] = res.value ?? [];
  if (rows.length === 0) throw new Error(`FLOW_NOT_FOUND: no cloud flow is named exactly "${args.name}". Use list_cloud_flows with name_contains.`);
  if (rows.length > 1) {
    throw new Error(
      `AMBIGUOUS_FLOW_NAME: ${rows.length} cloud flows are named "${args.name}" — pass flow_id: ` +
      rows.map((r) => `${r.workflowid} (${STATE_LABELS[r.statecode]}${r.ismanaged ? ", managed" : ""})`).join(", "),
    );
  }
  return rows[0]!.workflowid;
}

async function callerId(): Promise<string | null> {
  try {
    return ((await d365("WhoAmI")) as Json).UserId ?? null;
  } catch {
    return null;
  }
}

async function fetchConnectionReferences(logicalNames: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  if (logicalNames.length === 0) return out;
  const filter = logicalNames.map((n) => `connectionreferencelogicalname eq '${escapeODataString(n)}'`).join(" or ");
  const res = (await d365(`connectionreferences?$filter=${filter}&$select=${CONNREF_SELECT}`)) as Json;
  for (const row of res.value ?? []) out.set(String(row.connectionreferencelogicalname).toLowerCase(), row);
  return out;
}

async function resolveConnectionReference(ref: string): Promise<Json> {
  if (isGuid(ref)) return (await d365(`connectionreferences(${assertGuid(ref, "connection_reference")})?$select=${CONNREF_SELECT}`)) as Json;
  const rows = await fetchConnectionReferences([ref]);
  const row = rows.get(ref.toLowerCase());
  if (!row) throw new Error(`CONNECTION_REFERENCE_NOT_FOUND: no connection reference has logical name "${ref}". Use list_connection_references.`);
  return row;
}

/** Active (or all) cloud flows whose clientdata binds this connection reference logical name. */
async function flowsUsingConnectionReference(logicalName: string, activeOnly: boolean): Promise<Json[]> {
  // The closing quote pins an exact match: clientdata holds `"connectionReferenceLogicalName":"<name>"`,
  // so `<name>"` cannot also match a longer name that merely starts with this one.
  const needle = escapeODataString(`${logicalName}"`);
  const res = (await d365(
    `workflows?$filter=category eq ${FLOW_CATEGORY}${activeOnly ? " and statecode eq 1" : ""} and contains(clientdata,'${needle}')` +
    "&$select=workflowid,name,statecode,ismanaged",
  )) as Json;
  return (res.value ?? []).map((r: Json) => ({ id: r.workflowid, name: r.name, state: STATE_LABELS[r.statecode], managed: r.ismanaged }));
}

/**
 * A Dataverse-triggered flow is only live once Dataverse holds a non-deleted
 * callbackregistration named after its workflowid. Activation does not wait for it and does
 * not fail when it cannot be made, so this is the check that "On" actually means "will fire".
 */
async function verifyTriggerRegistration(flowId: string, attempts = flowTiming.registrationAttempts): Promise<Json> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let rows: Json[];
    try {
      const res = (await d365(
        `callbackregistrations?$filter=name eq '${flowId}' and softdeletestatus eq 0` +
        "&$select=callbackregistrationid,entityname,message,scope,filteringattributes",
      )) as Json;
      rows = res.value ?? [];
    } catch (err) {
      return { registered: null, note: `Could not read callbackregistrations to confirm the trigger: ${dataverseErrorMessage(err)}` };
    }
    if (rows.length > 0) {
      const r = rows[0]!;
      return { registered: true, table: r.entityname, message: r.message, ...(r.filteringattributes ? { filtering_attributes: r.filteringattributes } : {}) };
    }
    if (attempt < attempts - 1) await sleep(flowTiming.registrationPollMs);
  }
  return {
    registered: false,
    warning:
      "TRIGGER_NOT_REGISTERED: the flow is On but Dataverse holds no live webhook registration for its trigger, so it will not fire. " +
      "Activation does not surface this. Usual causes: filteringattributes on a change type without Modified, a wrong table name, " +
      "or the connection's user lacking privileges on the table. Open the flow's trigger history in the maker portal for the exact error.",
  };
}

// ─── Definition preparation (shared by validate/create/update) ────────────────

interface Prepared {
  clientdata: ClientData;
  issues: LintIssue[];
  added: string[];
}

/**
 * Build the final clientdata and check it against the environment: normalize the template,
 * resolve connection reference logical names to real rows (filling api.name from the row's
 * connector), then lint. Nothing is written.
 */
async function prepareClientData(input: {
  definition?: unknown;
  connection_references?: unknown;
  base?: ClientData | null;
}): Promise<Prepared> {
  const issues: LintIssue[] = [];
  let definition: Json;
  let refs: Record<string, ConnectionReferenceEntry> = { ...(input.base?.properties.connectionReferences ?? {}) };

  const defInput = coerceObject(input.definition, "definition");
  if (defInput) {
    const split = splitDefinitionInput(defInput);
    definition = split.definition;
    if (split.connectionReferences) refs = { ...refs, ...split.connectionReferences };
  } else if (input.base) {
    definition = input.base.properties.definition;
  } else {
    throw new Error("INVALID_ARGUMENT: definition is required.");
  }
  const { definition: normalized, added } = normalizeDefinition(definition);

  // connection_references: { "<connectionName key>": "<logical name>" | <full entry> }
  const refArg = coerceObject(input.connection_references, "connection_references") ?? {};
  const byLogicalName: Array<{ key: string; logical: string }> = [];
  for (const [key, value] of Object.entries(refArg)) {
    if (typeof value === "string") byLogicalName.push({ key, logical: value });
    else if (value && typeof value === "object") refs[key] = value as ConnectionReferenceEntry;
    else throw new Error(`INVALID_ARGUMENT: connection_references.${key} must be a connection reference logical name or an entry object.`);
  }

  const wanted = new Set([...connectionReferenceNames(refs), ...byLogicalName.map((b) => b.logical)]);
  const rows = await fetchConnectionReferences([...wanted]);
  for (const { key, logical } of byLogicalName) {
    const row = rows.get(logical.toLowerCase());
    // Use the row's exact logical name casing; Dataverse matches it case-sensitively at create.
    refs[key] = connectionReferenceEntry(row?.connectionreferencelogicalname ?? logical, apiNameFromConnectorId(row?.connectorid) || key.replace(/[-_]\d+$/, ""));
  }

  const me = await callerId();
  for (const [key, entry] of Object.entries(refs)) {
    const logical = entry?.connection?.connectionReferenceLogicalName;
    if (!logical) continue;
    const row = rows.get(logical.toLowerCase());
    const path = `connectionReferences.${key}`;
    if (!row) {
      issues.push({ severity: "error", code: "CONNECTION_REFERENCE_NOT_FOUND", path, message: `Connection reference "${logical}" does not exist in ${activeEnvironment!.name}. Create it (create_connection_reference) or pick one from list_connection_references.` });
      continue;
    }
    const api = apiNameFromConnectorId(row.connectorid);
    if (entry.api?.name && api && entry.api.name !== api) {
      issues.push({ severity: "error", code: "CONNECTOR_MISMATCH", path, message: `"${logical}" is a ${api} connection reference, but this entry declares api.name "${entry.api.name}".` });
    }
    if (!row.connectionid) {
      issues.push(api === DATAVERSE_API
        ? { severity: "warning", code: "UNBOUND_DATAVERSE_CONNECTION_REFERENCE", path, message: `"${logical}" has no connection. Dataverse actions still run (as the flow owner, through the implicit $authentication), but bind it before promoting.` }
        : { severity: "warning", code: "UNBOUND_CONNECTION_REFERENCE", path, message: `"${logical}" (${api}) has no connection — turning the flow on will fail until it is bound (update_connection_reference, or the maker portal).` });
    } else if (me && row._ownerid_value && row._ownerid_value !== me) {
      issues.push({ severity: "warning", code: "CONNECTION_OWNED_BY_SOMEONE_ELSE", path, message: `"${logical}" belongs to ${formatted(row, "_ownerid_value") ?? row._ownerid_value}. Turning the flow on fails with "Cannot find connection" unless that connection is shared with you.` });
    }
  }

  // Connector operations must target the same connector as the reference they name.
  const apiForKey = new Map(Object.entries(refs).map(([k, e]) => [k, e?.api?.name]));
  const checkApi = (node: Json, path: string) => {
    const host = node?.inputs?.host;
    if (!host?.apiId || !host.connectionName) return;
    const declared = apiForKey.get(host.connectionName);
    const used = apiNameFromConnectorId(host.apiId);
    if (declared && used && declared !== used && RIDES_ON[used] !== declared) {
      issues.push({ severity: "error", code: "CONNECTOR_MISMATCH", path, message: `Operation uses ${used} through connectionName "${host.connectionName}", which is a ${declared} reference.` });
    }
  };
  for (const [name, t] of Object.entries((normalized.triggers ?? {}) as Json)) checkApi(t, `triggers.${name}`);
  walkActions(normalized.actions, ({ action, path }) => checkApi(action, path));

  issues.push(...(await checkDataverseTableNames(normalized)));
  issues.push(...lintFlow(normalized, refs));
  return { clientdata: buildClientData(normalized, refs), issues, added };
}

/**
 * The Dataverse connector names tables two different ways: the row trigger takes the LOGICAL
 * name (`incident`), every action takes the entity SET name (`incidents`). Activation checks
 * neither — a wrong one fails at run time, or for a trigger never registers — so resolve every
 * literal table name against this org's metadata in one query.
 */
async function checkDataverseTableNames(definition: Json): Promise<LintIssue[]> {
  const wanted: Array<{ value: string; role: "trigger" | "action"; path: string }> = [];
  const isLiteral = (v: unknown): v is string => typeof v === "string" && v !== "" && !v.startsWith("@");
  const isDataverse = (node: Json) => apiNameFromConnectorId(node?.inputs?.host?.apiId) === DATAVERSE_API;

  for (const [name, t] of Object.entries((definition.triggers ?? {}) as Json)) {
    const table = t?.inputs?.parameters?.["subscriptionRequest/entityname"];
    // "none" is how the action/business-event trigger says "unbound" — not a table.
    if (isDataverse(t) && isLiteral(table) && table !== "none") wanted.push({ value: table, role: "trigger", path: `triggers.${name}` });
  }
  walkActions(definition.actions, ({ action, path }) => {
    const table = action.inputs?.parameters?.entityName;
    if (isDataverse(action) && isLiteral(table)) wanted.push({ value: table, role: "action", path });
  });
  if (wanted.length === 0) return [];

  const distinct = [...new Set(wanted.map((w) => w.value))];
  const filter = distinct
    .map((v) => `LogicalName eq '${escapeODataString(v)}' or EntitySetName eq '${escapeODataString(v)}'`)
    .join(" or ");
  let rows: Json[];
  try {
    rows = (((await d365(`EntityDefinitions?$select=LogicalName,EntitySetName&$filter=${filter}`)) as Json).value ?? []);
  } catch {
    return []; // metadata unavailable — the other checks still stand
  }
  const byLogical = new Map(rows.map((r) => [String(r.LogicalName).toLowerCase(), r]));
  const bySet = new Map(rows.map((r) => [String(r.EntitySetName).toLowerCase(), r]));

  const issues: LintIssue[] = [];
  for (const w of wanted) {
    const key = w.value.toLowerCase();
    if (w.role === "trigger") {
      if (byLogical.has(key)) continue;
      const asSet = bySet.get(key);
      issues.push(asSet
        ? { severity: "error", code: "DATAVERSE_TABLE_NAME", path: w.path, message: `The row trigger takes the table's logical name: use "${asSet.LogicalName}", not the entity set name "${w.value}".` }
        : { severity: "error", code: "DATAVERSE_TABLE_NOT_FOUND", path: w.path, message: `No table with logical name "${w.value}" exists in ${activeEnvironment!.name}.` });
    } else {
      if (bySet.has(key)) continue;
      const asLogical = byLogical.get(key);
      issues.push(asLogical
        ? { severity: "error", code: "DATAVERSE_TABLE_NAME", path: w.path, message: `Dataverse actions take the entity set name: use entityName "${asLogical.EntitySetName}", not the logical name "${w.value}".` }
        : { severity: "error", code: "DATAVERSE_TABLE_NOT_FOUND", path: w.path, message: `No table with entity set name "${w.value}" exists in ${activeEnvironment!.name}.` });
    }
  }
  return issues;
}

function errorsOf(issues: LintIssue[]): LintIssue[] {
  return issues.filter((i) => i.severity === "error");
}

function validationFailure(issues: LintIssue[]): Error {
  const errors = errorsOf(issues);
  return new Error(
    `VALIDATION_FAILED: ${errors.length} error(s), nothing was written.\n` +
    errors.map((e) => `- [${e.code}] ${e.message}${e.path ? ` (at ${e.path})` : ""}`).join("\n"),
  );
}

function issueLines(issues: LintIssue[], severity: LintIssue["severity"]): string[] {
  return issues.filter((i) => i.severity === severity).map((i) => `[${i.code}] ${i.message}${i.path ? ` (at ${i.path})` : ""}`);
}

/** Turn a flow on. Returns the outcome rather than throwing, so callers can report a created-but-off flow. */
async function activate(flowId: string): Promise<Json> {
  try {
    await d365(`workflows(${flowId})`, "PATCH", { statecode: 1, statuscode: 2 });
    return { ok: true };
  } catch (err) {
    const message = dataverseErrorMessage(err);
    return { ok: false, error: message, ...(explainFlowError(message) ?? {}) };
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────────

async function handleListCloudFlows(args: {
  name_contains?: string; state?: string; solution?: string; flow_type?: string;
  trigger_table?: string; definition_contains?: string; include_managed?: boolean; top?: number;
}): Promise<unknown> {
  requireEnv();
  const top = Math.min(Math.max(Number(args.top) || 100, 1), 500);
  const filters = [`category eq ${FLOW_CATEGORY}`];
  if (args.name_contains) filters.push(`contains(name,'${escapeODataString(args.name_contains)}')`);
  if (args.state === "on") filters.push("statecode eq 1");
  else if (args.state === "off") filters.push("statecode eq 0");
  if (args.flow_type && args.flow_type !== "all") {
    const t = FLOW_TYPE_FILTERS[args.flow_type];
    if (t === undefined) throw new Error(`INVALID_ARGUMENT: flow_type must be one of ${Object.keys(FLOW_TYPE_FILTERS).join(", ")}, all.`);
    filters.push(`modernflowtype eq ${t}`);
  }
  if (args.include_managed === false) filters.push("ismanaged eq false");
  if (args.definition_contains) filters.push(`contains(clientdata,'${escapeODataString(args.definition_contains)}')`);
  if (args.trigger_table) filters.push(`contains(clientdata,'${escapeODataString(args.trigger_table)}')`);

  // Narrowing to a solution is a join Dataverse cannot express from workflow, so fetch the
  // solution's flow ids first and intersect; the server-side `top` would otherwise cut too early.
  let inSolution: Set<string> | null = null;
  if (args.solution) {
    const sol = (await d365(`solutions?$filter=uniquename eq '${escapeODataString(args.solution)}'&$select=solutionid`)) as Json;
    const solutionId = sol.value?.[0]?.solutionid;
    if (!solutionId) throw new Error(`SOLUTION_NOT_FOUND: no solution has unique name "${args.solution}". Use list_solutions.`);
    const comps = (await d365(
      `solutioncomponents?$filter=_solutionid_value eq ${solutionId} and componenttype eq 29&$select=objectid`,
      "GET", undefined, { Prefer: "odata.maxpagesize=5000" },
    )) as Json;
    inSolution = new Set((comps.value ?? []).map((c: Json) => String(c.objectid).toLowerCase()));
  }

  const needsClientData = Boolean(args.trigger_table);
  // One row past `top` is how the response knows whether it was truncated.
  const serverTop = inSolution || needsClientData ? 5000 : top + 1;
  const res = (await d365(
    `workflows?$filter=${filters.join(" and ")}&$select=${FLOW_SELECT}${needsClientData ? ",clientdata" : ""}&$orderby=name asc&$top=${serverTop}`,
    "GET", undefined, { Prefer: `odata.include-annotations=*,odata.maxpagesize=${serverTop}` },
  )) as Json;

  let rows: Json[] = res.value ?? [];
  if (inSolution) rows = rows.filter((r) => inSolution!.has(String(r.workflowid).toLowerCase()));
  const matched: Json[] = [];
  for (const row of rows) {
    const flow = summarizeFlowRow(row);
    if (needsClientData) {
      const trigger = summarizeTrigger(parseClientData(row.clientdata)?.properties.definition ?? {});
      if (trigger?.dataverse?.table?.toLowerCase() !== args.trigger_table!.toLowerCase()) continue;
      flow.trigger = trigger.dataverse;
    }
    matched.push(flow);
    if (matched.length > top) break;
  }
  const out = matched.slice(0, top);
  return {
    environment: activeEnvironment!.name,
    count: out.length,
    ...(matched.length > top ? { truncated: `More than ${top} match; narrow the filters or raise top (max 500).` } : {}),
    flows: out,
  };
}

async function handleGetCloudFlow(args: { flow_id?: string; name?: string; include_definition?: boolean }): Promise<unknown> {
  requireEnv();
  const id = await resolveFlowId(args);
  const row = await getFlowRow(id, "clientdata,resourceid");
  const cd = parseClientData(row.clientdata);
  const definition = cd?.properties.definition ?? {};
  const refs = cd?.properties.connectionReferences ?? {};

  const [refRows, solutions, recent, envId] = await Promise.all([
    fetchConnectionReferences(connectionReferenceNames(refs)),
    d365(`solutioncomponents?$filter=objectid eq ${id} and componenttype eq 29&$select=_solutionid_value&$expand=solutionid($select=uniquename,friendlyname,ismanaged)`)
      .then((r) => ((r as Json).value ?? []).map((c: Json) => c.solutionid?.uniquename ?? c._solutionid_value))
      .catch(() => undefined),
    d365(`flowruns?$filter=_workflow_value eq ${id}&$select=name,status,starttime,errorcode&$orderby=starttime desc&$top=5`)
      .then((r) => ((r as Json).value ?? []).map((x: Json) => ({ run_id: x.name, status: x.status, start: x.starttime, ...(x.errorcode ? { error_code: x.errorcode } : {}) })))
      .catch(() => undefined),
    environmentId(),
  ]);

  const connection_references = Object.entries(refs).map(([key, entry]) => {
    const logical = entry?.connection?.connectionReferenceLogicalName;
    const r = logical ? refRows.get(logical.toLowerCase()) : undefined;
    return {
      key,
      logical_name: logical ?? null,
      runtime_source: entry?.runtimeSource,
      connector: r ? apiNameFromConnectorId(r.connectorid) : entry?.api?.name,
      ...(logical ? { exists: Boolean(r) } : {}),
      ...(r ? { bound: Boolean(r.connectionid), owner: formatted(r, "_ownerid_value") ?? r._ownerid_value } : {}),
    };
  });

  const result: Json = {
    ...summarizeFlowRow(row),
    environment: activeEnvironment!.name,
    version: row.versionnumber,
    created_on: row.createdon,
    modified_by: formatted(row, "_modifiedby_value") ?? row._modifiedby_value,
    portal_url: flowPortalUrl(envId, id),
    solutions,
    trigger: summarizeTrigger(definition),
    actions: outlineActions(definition),
    connection_references,
    recent_runs: recent,
  };
  // One look, no polling: on a read the flow has long since settled.
  if (row.statecode === 1 && hasDataverseWebhookTrigger(definition)) result.trigger_registration = await verifyTriggerRegistration(id, 1);
  if (args.include_definition !== false) {
    result.definition = definition;
    result.connection_references_raw = refs;
  }
  return result;
}

async function handleValidateCloudFlow(args: { definition: unknown; connection_references?: unknown }): Promise<unknown> {
  requireEnv();
  const prepared = await prepareClientData(args);
  return {
    valid: errorsOf(prepared.issues).length === 0,
    errors: issueLines(prepared.issues, "error"),
    warnings: issueLines(prepared.issues, "warning"),
    ...(prepared.added.length ? { added_boilerplate: prepared.added } : {}),
    trigger: summarizeTrigger(prepared.clientdata.properties.definition),
    note:
      "Static checks only. The Flow service does its own full template validation when a flow is turned on; " +
      "a Draft flow stores whatever it is given without validating it.",
  };
}

async function handleCreateCloudFlow(args: {
  name: string; definition: unknown; connection_references?: unknown; description?: string;
  solution?: string; activate?: boolean;
}): Promise<unknown> {
  requireEnv();
  if (!args.name?.trim()) throw new Error("INVALID_ARGUMENT: name is required.");
  const prepared = await prepareClientData(args);
  if (errorsOf(prepared.issues).length) throw validationFailure(prepared.issues);

  const body: Json = {
    category: FLOW_CATEGORY,
    type: 1, // Definition
    primaryentity: "none",
    name: args.name.trim(),
    clientdata: JSON.stringify(prepared.clientdata),
  };
  if (args.description) body.description = args.description;
  const headers = args.solution ? { "MSCRM.SolutionUniqueName": args.solution } : undefined;
  const created = (await d365("workflows", "POST", body, headers)) as Json;
  const id: string = created.id;

  const warnings = issueLines(prepared.issues, "warning");
  if (!args.solution) {
    warnings.push("Created outside any solution (it lands in the Default solution), so it will not travel with ALM. Pass solution to create it inside one.");
  }

  const result: Json = {
    id,
    name: body.name,
    environment: activeEnvironment!.name,
    solution: args.solution ?? null,
    state: "Off",
    portal_url: flowPortalUrl(await environmentId(), id),
  };

  if (args.activate) {
    // Activation would fail on it anyway; skipping says why without a misleading Flow-service error.
    const unboundNonDataverse = prepared.issues.find((i) => i.code === "UNBOUND_CONNECTION_REFERENCE");
    if (unboundNonDataverse) {
      result.activation = { ok: false, skipped: true, cause: unboundNonDataverse.message, fix: "Bind the connection reference, then call set_cloud_flow_state with state on." };
    } else {
      result.activation = await activate(id);
      if (result.activation.ok) {
        result.state = "On";
        if (hasDataverseWebhookTrigger(prepared.clientdata.properties.definition)) {
          result.trigger_registration = await verifyTriggerRegistration(id);
        }
      } else {
        result.activation.note = "The flow was created and saved, but it is Off. Fix the cause, then update_cloud_flow and/or set_cloud_flow_state on.";
      }
    }
  } else {
    warnings.push("The flow is Off. Draft flows are stored without template validation — set_cloud_flow_state on is the real validation.");
  }
  if (prepared.added.length) result.added_boilerplate = prepared.added;
  if (warnings.length) result.warnings = warnings;
  return result;
}

async function handleUpdateCloudFlow(args: {
  flow_id: string; name?: string; description?: string; definition?: unknown;
  connection_references?: unknown; expected_version?: string | number; allow_managed?: boolean;
}): Promise<unknown> {
  requireEnv();
  const id = assertGuid(args.flow_id, "flow_id");
  const row = await getFlowRow(id, "clientdata");
  if (row.ismanaged && !args.allow_managed) {
    throw new Error(
      `MANAGED_FLOW: "${row.name}" is managed. Editing it here creates an unmanaged layer on top of the managed solution, ` +
      "which then masks every future upgrade of that flow. Change it in the source (unmanaged) environment and redeploy the solution. " +
      "Pass allow_managed: true only if you deliberately want that layer.",
    );
  }

  const body: Json = {};
  const updated: string[] = [];
  if (args.name !== undefined) { body.name = args.name; updated.push("name"); }
  if (args.description !== undefined) { body.description = args.description; updated.push("description"); }

  let prepared: Prepared | null = null;
  if (args.definition !== undefined || args.connection_references !== undefined) {
    prepared = await prepareClientData({ definition: args.definition, connection_references: args.connection_references, base: parseClientData(row.clientdata) });
    if (errorsOf(prepared.issues).length) throw validationFailure(prepared.issues);
    body.clientdata = JSON.stringify(prepared.clientdata);
    updated.push(args.definition !== undefined ? "definition" : "connection_references");
  }
  if (updated.length === 0) throw new Error("INVALID_ARGUMENT: nothing to update — pass name, description, definition and/or connection_references.");

  const wasOn = row.statecode === 1;
  const headers = args.expected_version !== undefined ? { "If-Match": `W/"${String(args.expected_version).replace(/^W\/|"/g, "")}"` } : undefined;
  try {
    await d365(`workflows(${id})`, "PATCH", body, headers);
  } catch (err) {
    const message = dataverseErrorMessage(err);
    const status = /^D365 (\d+)/.exec(err instanceof Error ? err.message : "")?.[1];
    const hint = explainFlowError(status === "412" ? "412" : message);
    throw new Error(
      `UPDATE_FAILED: ${message}` +
      (hint ? `\nCause: ${hint.cause}\nFix: ${hint.fix}` : "") +
      (wasOn && body.clientdata ? "\nThe flow is still On and still running its previous definition — Dataverse rejected the change as a whole." : ""),
    );
  }

  const result: Json = { id, name: body.name ?? row.name, updated, state: STATE_LABELS[row.statecode] };
  const warnings = prepared ? issueLines(prepared.issues, "warning") : [];
  if (prepared && wasOn) {
    result.note = "The flow was On, so the Flow service validated and deployed the new definition immediately.";
    if (hasDataverseWebhookTrigger(prepared.clientdata.properties.definition)) result.trigger_registration = await verifyTriggerRegistration(id);
  } else if (prepared) {
    warnings.push("The flow is Off, so the new definition was stored without validation. set_cloud_flow_state on validates and deploys it.");
  }
  if (row.ismanaged) warnings.push("This flow is managed: the change now sits in an unmanaged layer above the managed solution.");
  if (prepared?.added.length) result.added_boilerplate = prepared.added;
  if (warnings.length) result.warnings = warnings;
  return result;
}

async function handleSetCloudFlowState(args: { flow_id: string; state: string }): Promise<unknown> {
  requireEnv();
  const id = assertGuid(args.flow_id, "flow_id");
  if (!["on", "off", "restart"].includes(args.state)) throw new Error("INVALID_ARGUMENT: state must be on, off or restart.");
  const row = await getFlowRow(id, "clientdata");
  const definition = parseClientData(row.clientdata)?.properties.definition ?? {};
  const before = STATE_LABELS[row.statecode];

  if (args.state === "off" || args.state === "restart") {
    if (row.statecode !== 0) await d365(`workflows(${id})`, "PATCH", { statecode: 0, statuscode: 1 });
    if (args.state === "off") return { id, name: row.name, state: "Off", previous_state: before };
  }

  const activation = await activate(id);
  if (!activation.ok) {
    return { id, name: row.name, state: "Off", previous_state: before, activation, note: "The flow is Off. Nothing about its definition was changed." };
  }
  const result: Json = { id, name: row.name, state: "On", previous_state: before };
  if (hasDataverseWebhookTrigger(definition)) result.trigger_registration = await verifyTriggerRegistration(id);
  return result;
}

async function handleDeleteCloudFlow(args: { flow_id: string; force?: boolean }): Promise<unknown> {
  requireEnv();
  const id = assertGuid(args.flow_id, "flow_id");
  const row = await getFlowRow(id);
  if (row.ismanaged) {
    throw new Error(`MANAGED_FLOW: "${row.name}" is managed and cannot be deleted on its own — remove it from the source solution and upgrade, or uninstall the solution.`);
  }
  // A child flow is called by workflowid from its parents; deleting it breaks them at their next run.
  const callers = (await d365(
    `workflows?$filter=category eq ${FLOW_CATEGORY} and workflowid ne ${id} and contains(clientdata,'${id}')&$select=workflowid,name,statecode`,
  )) as Json;
  const parents = (callers.value ?? []).map((r: Json) => ({ id: r.workflowid, name: r.name, state: STATE_LABELS[r.statecode] }));
  if (parents.length && !args.force) {
    throw new Error(
      `FLOW_IN_USE: ${parents.length} other flow(s) reference this flow's id (typically as a child flow): ` +
      parents.map((p: Json) => `"${p.name}" (${p.id}, ${p.state})`).join(", ") +
      ". Deleting it breaks them at their next run. Pass force: true to delete anyway.",
    );
  }
  await d365(`workflows(${id})`, "DELETE");
  return {
    deleted: true,
    id,
    name: row.name,
    was: STATE_LABELS[row.statecode],
    ...(parents.length ? { broken_callers: parents } : {}),
    note: "Removed from Dataverse and from the Flow service. This cannot be undone; a solution export is the only backup.",
  };
}

async function handleListCloudFlowRuns(args: { flow_id?: string; status?: string; since?: string; top?: number }): Promise<unknown> {
  requireEnv();
  const top = Math.min(Math.max(Number(args.top) || 50, 1), 500);
  const filters: string[] = [];
  let flowId: string | undefined;
  if (args.flow_id) { flowId = assertGuid(args.flow_id, "flow_id"); filters.push(`_workflow_value eq ${flowId}`); }
  if (args.status) {
    if (!RUN_STATUSES.has(args.status)) throw new Error(`INVALID_ARGUMENT: status must be one of ${[...RUN_STATUSES].join(", ")}.`);
    filters.push(`status eq '${args.status}'`);
  }
  if (args.since) {
    const since = new Date(args.since);
    if (Number.isNaN(since.getTime())) throw new Error(`INVALID_ARGUMENT: since must be an ISO date/time, got "${args.since}".`);
    filters.push(`starttime ge ${since.toISOString()}`);
  }
  const fq = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  const res = (await d365(
    `flowruns?${fq}$select=name,status,starttime,endtime,triggertype,duration,errorcode,errormessage,_workflow_value&$orderby=starttime desc&$top=${top}`,
  )) as Json;
  const envId = await environmentId();

  const runs = (res.value ?? []).map((r: Json) => {
    let error: unknown = undefined;
    if (r.errorcode || r.errormessage) {
      let msg: unknown = r.errormessage;
      try { msg = r.errormessage ? JSON.parse(r.errormessage) : undefined; } catch { /* keep the raw text */ }
      error = { code: r.errorcode, message: msg };
    }
    const wf: string | undefined = r._workflow_value;
    return {
      run_id: r.name,
      ...(flowId ? {} : { flow: formatted(r, "_workflow_value") ?? wf, flow_id: wf }),
      status: r.status,
      trigger: r.triggertype,
      start: r.starttime,
      end: r.endtime,
      duration_ms: r.duration,
      ...(error ? { error } : {}),
      ...(envId && wf ? { portal_url: `https://make.powerautomate.com/environments/${envId}/flows/${wf}/runs/${r.name}` } : {}),
    };
  });

  let counts: Json | undefined;
  if (flowId) {
    try {
      const agg = (await d365(`flowruns?$apply=filter(${filters.join(" and ")})/groupby((status),aggregate($count as n))`)) as Json;
      counts = Object.fromEntries((agg.value ?? []).map((g: Json) => [g.status, g.n]));
    } catch { /* counts are a convenience */ }
  }
  return {
    environment: activeEnvironment!.name,
    count: runs.length,
    ...(counts ? { counts_for_filter: counts } : {}),
    runs,
    note: "Run history reaches Dataverse about 5 minutes after a run finishes, is kept 28 days, and does not include in-progress runs.",
  };
}

async function handleCancelCloudFlowRuns(args: { flow_id: string }): Promise<unknown> {
  requireEnv();
  const id = assertGuid(args.flow_id, "flow_id");
  const row = await getFlowRow(id);
  await d365(`workflows(${id})/Microsoft.Dynamics.CRM.CancelAllCloudFlowRuns`, "POST", {});
  return {
    id,
    name: row.name,
    cancelled: "all in-progress runs",
    state: STATE_LABELS[row.statecode],
    note: row.statecode === 1 ? "The flow is still On — new triggers start new runs. Turn it off first to stop it firing." : undefined,
  };
}

async function handleListConnectionReferences(args: {
  connector?: string; name_contains?: string; unbound_only?: boolean; include_flows?: boolean; top?: number;
}): Promise<unknown> {
  requireEnv();
  const top = Math.min(Math.max(Number(args.top) || 100, 1), 500);
  const filters: string[] = [];
  if (args.connector) filters.push(`contains(connectorid,'${escapeODataString(args.connector)}')`);
  if (args.name_contains) {
    const n = escapeODataString(args.name_contains);
    filters.push(`(contains(connectionreferencelogicalname,'${n}') or contains(connectionreferencedisplayname,'${n}'))`);
  }
  if (args.unbound_only) filters.push("connectionid eq null");
  const fq = filters.length ? `$filter=${filters.join(" and ")}&` : "";
  const res = (await d365(`connectionreferences?${fq}$select=${CONNREF_SELECT}&$orderby=connectionreferencelogicalname asc&$top=${top}`)) as Json;
  const rows: Json[] = res.value ?? [];
  if (args.include_flows && rows.length > 25) {
    throw new Error(`INVALID_ARGUMENT: include_flows looks up each reference separately; narrow to 25 or fewer (matched ${rows.length}).`);
  }
  const me = await callerId();
  const refs = await Promise.all(rows.map(async (r) => ({
    id: r.connectionreferenceid,
    logical_name: r.connectionreferencelogicalname,
    display_name: r.connectionreferencedisplayname,
    connector: apiNameFromConnectorId(r.connectorid),
    bound: Boolean(r.connectionid),
    connection_id: r.connectionid ?? null,
    owner: formatted(r, "_ownerid_value") ?? r._ownerid_value,
    ...(me ? { owned_by_you: r._ownerid_value === me } : {}),
    managed: r.ismanaged,
    ...(args.include_flows ? { used_by: await flowsUsingConnectionReference(r.connectionreferencelogicalname, false) } : {}),
  })));
  return { environment: activeEnvironment!.name, count: refs.length, connection_references: refs };
}

function normalizeConnectorId(connector: string): string {
  const c = connector.trim();
  if (c.startsWith("/providers/")) return c;
  return `/providers/Microsoft.PowerApps/apis/${c.startsWith("shared_") ? c : `shared_${c}`}`;
}

async function handleCreateConnectionReference(args: {
  logical_name: string; connector: string; display_name?: string; connection_id?: string;
  description?: string; solution?: string;
}): Promise<unknown> {
  requireEnv();
  if (!/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(args.logical_name ?? "")) {
    throw new Error("INVALID_ARGUMENT: logical_name must start with a publisher prefix and contain only letters, digits and underscores, e.g. new_sharedcommondataserviceforapps_tickets.");
  }
  if (!args.connector) throw new Error("INVALID_ARGUMENT: connector is required, e.g. shared_commondataserviceforapps.");
  const body: Json = {
    connectionreferencelogicalname: args.logical_name,
    connectionreferencedisplayname: args.display_name ?? args.logical_name,
    connectorid: normalizeConnectorId(args.connector),
  };
  if (args.connection_id) body.connectionid = args.connection_id;
  if (args.description) body.description = args.description;
  const headers = args.solution ? { "MSCRM.SolutionUniqueName": args.solution } : undefined;
  const created = (await d365("connectionreferences", "POST", body, headers)) as Json;
  return {
    id: created.id,
    logical_name: args.logical_name,
    connector: apiNameFromConnectorId(body.connectorid),
    bound: Boolean(args.connection_id),
    solution: args.solution ?? null,
    next: args.connection_id
      ? `Use it from a flow with connection_references: { "${apiNameFromConnectorId(body.connectorid)}": "${args.logical_name}" }.`
      : "It has no connection yet. Bind one with update_connection_reference (connection_id) or in the maker portal — flows using it cannot be turned on until then (Dataverse-connector references excepted).",
  };
}

async function handleUpdateConnectionReference(args: {
  connection_reference: string; connection_id?: string; display_name?: string; description?: string; restart_flows?: boolean;
}): Promise<unknown> {
  requireEnv();
  const ref = await resolveConnectionReference(args.connection_reference);
  const body: Json = {};
  if (args.connection_id !== undefined) body.connectionid = args.connection_id;
  if (args.display_name !== undefined) body.connectionreferencedisplayname = args.display_name;
  if (args.description !== undefined) body.description = args.description;
  if (Object.keys(body).length === 0 && !args.restart_flows) {
    throw new Error("INVALID_ARGUMENT: nothing to update — pass connection_id, display_name, description and/or restart_flows.");
  }
  if (Object.keys(body).length) await d365(`connectionreferences(${ref.connectionreferenceid})`, "PATCH", body);

  const result: Json = { id: ref.connectionreferenceid, logical_name: ref.connectionreferencelogicalname, updated: Object.keys(body) };
  // restart_flows alone is the follow-up to an earlier rebind, so it must not depend on this call changing the binding.
  const rebound = args.connection_id !== undefined && args.connection_id !== ref.connectionid;
  if (!rebound && !args.restart_flows) return result;

  // Verified against a live org: an active flow keeps the connection it was activated with. Rebinding the
  // reference changes nothing for it until it is turned off and on again.
  const active = await flowsUsingConnectionReference(ref.connectionreferencelogicalname, true);
  if (active.length === 0) return { ...result, active_flows: [] };
  if (!args.restart_flows) {
    return {
      ...result,
      active_flows: active,
      warning: `${active.length} active flow(s) still run with the previous connection until restarted. Call set_cloud_flow_state with state restart on each, or repeat this call with restart_flows: true.`,
    };
  }
  if (active.length > MAX_RESTARTS_PER_CALL) {
    return {
      ...result,
      active_flows: active,
      warning: `${active.length} active flows use this reference — more than the ${MAX_RESTARTS_PER_CALL} this call restarts at once. None were restarted; call set_cloud_flow_state with state restart on each.`,
    };
  }
  const restarted: Json[] = [];
  for (const f of active) {
    const outcome = (await handleSetCloudFlowState({ flow_id: f.id, state: "restart" })) as Json;
    restarted.push({ id: f.id, name: f.name, state: outcome.state, ...(outcome.activation ? { activation: outcome.activation } : {}), ...(outcome.trigger_registration ? { trigger_registration: outcome.trigger_registration } : {}) });
  }
  return { ...result, restarted };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = new Server(
  { name: "dynamics365-mcp", version: "6.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// ─── MCP Resources — Dataverse Schema Dictionary ────────────────────────────
// Exposes entity schemas as resources so Claude can load them into context
// without making tool calls. URI format: dataverse://schema/{entity_logical_name}

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "dataverse://schema/{entity_logical_name}",
      name: "Dataverse Entity Schema",
      description: "Full schema for a Dataverse entity including all attributes, relationships, and option sets. Use this to load entity context before writing queries or plugins.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // List commonly used entities as pre-built resources
  if (!activeEnvironment) return { resources: [] };
  const commonEntities = [
    "account", "contact", "opportunity", "incident", "lead",
    "systemuser", "team", "businessunit", "queue",
  ];
  return {
    resources: commonEntities.map((e) => ({
      uri: `dataverse://schema/${e}`,
      name: `${e} schema`,
      description: `Full schema for the ${e} entity`,
      mimeType: "application/json",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const match = uri.match(/^dataverse:\/\/schema\/(.+)$/);
  if (!match) throw new Error(`Unknown resource URI: ${uri}`);

  const entityName = match[1];
  requireEnv();

  // Fetch entity details, attributes, and relationships in parallel
  const [details, attributes, relationships] = await Promise.all([
    d365(`EntityDefinitions(LogicalName='${entityName}')?$select=LogicalName,DisplayName,ObjectTypeCode,IsCustomEntity,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,Description`),
    handleGetEntityAttributes({ entity_logical_name: entityName, include_option_sets: true }),
    handleGetEntityRelationships({ entity_logical_name: entityName }),
  ]);

  const schema = {
    entity: details,
    attributes: (attributes as any).value,
    relationships,
    _generated_at: new Date().toISOString(),
    _environment: activeEnvironment?.name,
  };

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(schema, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: unknown;
    switch (name) {
      // Auth
      case "authenticate": result = await handleAuthenticate(args as any); break;
      case "auth_status": result = await handleAuthStatus(); break;
      // Environment
      case "list_environments": result = handleListEnvironments(); break;
      case "select_environment": result = handleSelectEnvironment(args as any); break;
      case "add_environment": result = handleAddEnvironment(args as any); break;
      // Metadata
      case "list_entities": result = await handleListEntities(args as any); break;
      case "get_entity_details": result = await handleGetEntityDetails(args as any); break;
      case "get_entity_attributes": result = await handleGetEntityAttributes(args as any); break;
      case "get_entity_relationships": result = await handleGetEntityRelationships(args as any); break;
      case "get_entity_keys": result = await handleGetEntityKeys(args as any); break;
      case "get_picklist_options": result = await handleGetPicklistOptions(args as any); break;
      case "get_global_option_sets": result = await handleGetGlobalOptionSets(args as any); break;
      case "get_global_option_set_details": result = await handleGetGlobalOptionSetDetails(args as any); break;
      // Data
      case "query_records": result = await handleQueryRecords(args as any); break;
      case "get_record": result = await handleGetRecord(args as any); break;
      case "create_record": result = await handleCreateRecord(args as any); break;
      case "update_record": result = await handleUpdateRecord(args as any); break;
      case "delete_record": result = await handleDeleteRecord(args as any); break;
      case "execute_fetchxml": result = await handleExecuteFetchXml(args as any); break;
      case "execute_action": result = await handleExecuteAction(args as any); break;
      case "associate_records": result = await handleAssociateRecords(args as any); break;
      // Bulk Delete
      case "create_bulk_delete_job": result = await handleCreateBulkDeleteJob(args as any); break;
      case "list_bulk_delete_jobs": result = await handleListBulkDeleteJobs(args as any); break;
      case "get_bulk_delete_job": result = await handleGetBulkDeleteJob(args as any); break;
      case "cancel_bulk_delete_job": result = await handleCancelBulkDeleteJob(args as any); break;
      case "get_bulk_delete_failures": result = await handleGetBulkDeleteFailures(args as any); break;
      // Security & Users
      case "get_current_user": result = await handleGetCurrentUser(); break;
      case "find_users": result = await handleFindUsers(args as any); break;
      case "get_user_roles": result = await handleGetUserRoles(args as any); break;
      case "get_user_teams": result = await handleGetUserTeams(args as any); break;
      case "get_user_queues": result = await handleGetUserQueues(args as any); break;
      case "list_security_roles": result = await handleListSecurityRoles(args as any); break;
      case "get_role_privileges": result = await handleGetRolePrivileges(args as any); break;
      case "compare_role_privileges": result = await handleCompareRolePrivileges(args as any); break;
      // Custom Actions & APIs
      case "find_custom_actions": result = await handleFindCustomActions(args as any); break;
      case "get_custom_action_metadata": result = await handleGetCustomActionMetadata(args as any); break;
      case "find_custom_apis": result = await handleFindCustomApis(args as any); break;
      case "get_custom_api_metadata": result = await handleGetCustomApiMetadata(args as any); break;
      // Plugin Traces
      case "get_plugin_traces": result = await handleGetPluginTraces(args as any); break;
      // Solutions
      case "list_solutions": result = await handleListSolutions(args as any); break;
      case "get_solution_details": result = await handleGetSolutionDetails(args as any); break;
      case "get_solution_components": result = await handleGetSolutionComponents(args as any); break;
      case "get_solution_dependencies": result = await handleGetSolutionDependencies(args as any); break;
      // Plugin Registration Tool (v5)
      case "list_plugin_assemblies": result = await handleListPluginAssemblies(args as any); break;
      case "get_plugin_assembly_details": result = await handleGetPluginAssemblyDetails(args as any); break;
      case "list_plugin_types": result = await handleListPluginTypes(args as any); break;
      case "list_sdk_messages": result = await handleListSdkMessages(args as any); break;
      case "list_sdk_message_filters": result = await handleListSdkMessageFilters(args as any); break;
      case "list_processing_steps": result = await handleListProcessingSteps(args as any); break;
      case "get_processing_step_details": result = await handleGetProcessingStepDetails(args as any); break;
      case "register_processing_step": result = await handleRegisterProcessingStep(args as any); break;
      case "update_processing_step": result = await handleUpdateProcessingStep(args as any); break;
      case "toggle_processing_step": result = await handleToggleProcessingStep(args as any); break;
      case "delete_processing_step": result = await handleDeleteProcessingStep(args as any); break;
      case "list_step_images": result = await handleListStepImages(args as any); break;
      case "register_step_image": result = await handleRegisterStepImage(args as any); break;
      case "update_step_image": result = await handleUpdateStepImage(args as any); break;
      case "delete_step_image": result = await handleDeleteStepImage(args as any); break;
      case "list_service_endpoints": result = await handleListServiceEndpoints(args as any); break;
      case "get_service_endpoint_details": result = await handleGetServiceEndpointDetails(args as any); break;
      case "register_webhook": result = await handleRegisterWebhook(args as any); break;
      case "register_service_bus_endpoint": result = await handleRegisterServiceBusEndpoint(args as any); break;
      case "update_service_endpoint": result = await handleUpdateServiceEndpoint(args as any); break;
      case "delete_service_endpoint": result = await handleDeleteServiceEndpoint(args as any); break;
      case "get_org_settings": result = await handleGetOrgSettings(); break;
      case "set_plugin_trace_setting": result = await handleSetPluginTraceSetting(args as any); break;
      // Web Resources
      case "list_web_resources": result = await handleListWebResources(args as any); break;
      case "get_web_resource": result = await handleGetWebResource(args as any); break;
      case "update_web_resource": result = await handleUpdateWebResource(args as any); break;
      case "create_web_resource": result = await handleCreateWebResource(args as any); break;
      // ALM Operations
      case "publish_customizations": result = await handlePublishCustomizations(args as any); break;
      case "export_solution": result = await handleExportSolution(args as any); break;
      case "import_solution": result = await handleImportSolution(args as any); break;
      // Environment Variables
      case "list_environment_variables": result = await handleListEnvironmentVariables(args as any); break;
      case "get_environment_variable": result = await handleGetEnvironmentVariable(args as any); break;
      case "set_environment_variable": result = await handleSetEnvironmentVariable(args as any); break;
      // Role Assignment
      case "assign_security_role": result = await handleAssignSecurityRole(args as any); break;
      case "remove_security_role": result = await handleRemoveSecurityRole(args as any); break;
      // Audit History
      case "get_audit_history": result = await handleGetAuditHistory(args as any); break;
      case "get_entity_audit_status": result = await handleGetEntityAuditStatus(args as any); break;
      case "get_field_audit_status": result = await handleGetFieldAuditStatus(args as any); break;
      case "get_org_audit_status": result = await handleGetOrgAuditStatus(); break;
      // Managed Identity
      case "list_managed_identities": result = await handleListManagedIdentities(args as any); break;
      case "create_managed_identity": result = await handleCreateManagedIdentity(args as any); break;
      case "associate_assembly_managed_identity": result = await handleAssociateAssemblyManagedIdentity(args as any); break;
      case "compute_federated_credential_subject": result = handleComputeFederatedCredentialSubject(args as any); break;
      // Batch
      case "execute_batch": result = await handleExecuteBatch(args as any); break;
      // Power Automate (cloud flows)
      case "list_cloud_flows": result = await handleListCloudFlows(args as any); break;
      case "get_cloud_flow": result = await handleGetCloudFlow(args as any); break;
      case "validate_cloud_flow": result = await handleValidateCloudFlow(args as any); break;
      case "create_cloud_flow": result = await handleCreateCloudFlow(args as any); break;
      case "update_cloud_flow": result = await handleUpdateCloudFlow(args as any); break;
      case "set_cloud_flow_state": result = await handleSetCloudFlowState(args as any); break;
      case "delete_cloud_flow": result = await handleDeleteCloudFlow(args as any); break;
      case "list_cloud_flow_runs": result = await handleListCloudFlowRuns(args as any); break;
      case "cancel_cloud_flow_runs": result = await handleCancelCloudFlowRuns(args as any); break;
      case "list_connection_references": result = await handleListConnectionReferences(args as any); break;
      case "create_connection_reference": result = await handleCreateConnectionReference(args as any); break;
      case "update_connection_reference": result = await handleUpdateConnectionReference(args as any); break;

      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

async function main() {
  const envInfo = ENVIRONMENTS.length
    ? `${ENVIRONMENTS.length} env(s): ${ENVIRONMENTS.map((e) => e.name).join(", ")}${activeEnvironment ? ` [active: ${activeEnvironment.name}]` : ""}`
    : "no environments pre-configured — use add_environment";
  console.error(`D365 MCP v6 ready (delegated auth — signs in as you via az login). ${envInfo}.`);
  await server.connect(new StdioServerTransport());
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
