# Cloud flow definition cookbook

Shapes taken from live, working Dataverse flows. Read this when authoring or editing a definition
for `create_cloud_flow` / `update_cloud_flow`.

## Basics

Pass only the `definition` — the tools add `$schema`, `contentVersion`, and the `$connections` /
`$authentication` parameters. Exactly **one** trigger. `runAfter` may only name actions in the **same
scope**; an action with `runAfter: {}` runs first in its scope.

**Manual (instant) trigger**
```json
"triggers": { "manual": { "type": "Request", "kind": "Button",
  "inputs": { "schema": { "type": "object", "properties": {}, "required": [] } } } }
```

**Recurrence**
```json
"triggers": { "Recurrence": { "type": "Recurrence",
  "recurrence": { "frequency": "Hour", "interval": 1, "startTime": "2026-01-01T07:00:00Z", "timeZone": "UTC" } } }
```

**Dataverse row trigger** — `entityname` is the **logical** name
```json
"triggers": { "When_a_case_is_modified": { "type": "OpenApiConnectionWebhook",
  "inputs": {
    "host": { "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
              "connectionName": "shared_commondataserviceforapps", "operationId": "SubscribeWebhookTrigger" },
    "parameters": {
      "subscriptionRequest/message": 3,
      "subscriptionRequest/entityname": "incident",
      "subscriptionRequest/scope": 4,
      "subscriptionRequest/filteringattributes": "statecode",
      "subscriptionRequest/filterexpression": "statecode eq 1"
    },
    "authentication": "@parameters('$authentication')" } } }
```
| `message` | Change type | | `scope` | Fires for rows owned by |
|---|---|---|---|---|
| 1 | Added | | 1 | the flow owner (User) |
| 2 | Deleted | | 2 | the owner's business unit |
| 3 | Modified | | 3 | that BU + child BUs |
| 4 | Added or Modified | | 4 | anyone (Organization) |
| 5 | Added or Deleted | | | |
| 6 | Modified or Deleted | | | |
| 7 | Added, Modified or Deleted | | | |

`filteringattributes` only with 3, 4, 6 or 7. Always set `filterexpression` / `filteringattributes`
when you can — an unfiltered Modified trigger on `incident` fires on every save.
Trigger row fields: `@triggerOutputs()?['body/<column>']`; lookups: `body/_<lookup>_value`.

**Dataverse actions** — `entityName` is the **entity set** name; host is the same as the trigger's,
only `operationId` changes:

| operationId | parameters |
|---|---|
| `ListRecords` | `entityName`, `$select`, `$filter`, `$orderby`, `$top`, `$expand` — or `fetchXml` |
| `GetItem` | `entityName`, `recordId`, `$select` |
| `CreateRecord` | `entityName`, `item/<column>`… (lookup: `item/<navprop>@odata.bind`: `/accounts(<id>)`) |
| `UpdateOnlyRecord` | `entityName`, `recordId`, `item/<column>`… — the designer's "Update a row"; `UpdateRecord` is the upsert variant |
| `DeleteRecord` | `entityName`, `recordId` |
| `PerformBoundAction` | `entityName`, `recordId`, `actionName` (`Microsoft.Dynamics.CRM.<Action>`), `item/<param>` |
| `PerformUnboundAction` | `actionName`, `item/<param>` |

```json
"Update_case": { "type": "OpenApiConnection", "runAfter": {},
  "inputs": {
    "host": { "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
              "connectionName": "shared_commondataserviceforapps", "operationId": "UpdateOnlyRecord" },
    "parameters": { "entityName": "incidents",
                    "recordId": "@triggerOutputs()?['body/incidentid']",
                    "item/new_lastflowcheck": "@utcNow()" },
    "authentication": "@parameters('$authentication')" } }
```
Results: `@outputs('List_rows')?['body/value']` (list), `@outputs('Get_row')?['body/<column>']` (single).

**Built-ins**: `Compose` (`inputs`), `InitializeVariable` / `SetVariable`, `If` (`expression`,
`actions`, `else.actions`), `Foreach` (`foreach`, `actions`), `Scope`, `Terminate`
(`inputs: { runStatus: "Failed", runError: { code, message } }`).

**Try/Catch** — the standard error-handling pattern:
```json
"Try":   { "type": "Scope", "runAfter": {}, "actions": { … } },
"Catch": { "type": "Scope", "runAfter": { "Try": ["Failed", "TimedOut"] }, "actions": { … } }
```

**Child flow** — the child must be a solution flow with a manual trigger (and a "Respond to a Power App
or flow" action if it returns data); reference it by workflowid:
```json
"Run_child": { "type": "Workflow", "runAfter": {},
  "inputs": { "host": { "workflowReferenceName": "<child workflowid GUID>" }, "body": { "text": "…" } } }
```
