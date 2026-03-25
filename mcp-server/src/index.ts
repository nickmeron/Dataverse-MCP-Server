#!/usr/bin/env node
/**
 * Dynamics 365 MCP Server v5 — Full-Stack Dataverse Tooling + Plugin Registration
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
 *
 * Required env vars:
 *   D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET
 *
 * Optional env vars:
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

// ─── Config ──────────────────────────────────────────────────────────────────

const TENANT_ID = process.env.D365_TENANT_ID ?? "";
const CLIENT_ID = process.env.D365_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.D365_CLIENT_SECRET ?? "";
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

// ─── Token Cache ──────────────────────────────────────────────────────────────

const tokenCache = new Map<string, { value: string; expiresAt: number }>();

async function getAccessToken(orgUrl: string): Promise<string> {
  const cached = tokenCache.get(orgUrl);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET)
    throw new Error("Missing env vars: D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET");
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials", client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET, scope: `${orgUrl}/.default`,
      }).toString(),
    }
  );
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(orgUrl, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
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
  // ───────────────────────────── ENVIRONMENT ─────────────────────────────────
  {
    name: "list_environments",
    description: "List all D365 environments. ALWAYS call first, then select_environment.",
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
];

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

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
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = new Server(
  { name: "dynamics365-mcp", version: "5.0.0" },
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

      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

async function main() {
  if (!ENVIRONMENTS.length) console.error("D365 MCP v5 ready. No environments pre-configured — use add_environment or ask the user for their org URL.");
  else console.error(`D365 MCP v5 ready. ${ENVIRONMENTS.length} env(s): ${ENVIRONMENTS.map((e) => e.name).join(", ")}${activeEnvironment ? ` [active: ${activeEnvironment.name}]` : ""}`);
  await server.connect(new StdioServerTransport());
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
