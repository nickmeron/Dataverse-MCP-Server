---
description: Manage webhooks and Service Bus endpoints in Dynamics 365 — register webhooks, create Service Bus queue/topic/Event Hub integrations, view endpoints and their registered steps. Use when asked "register a webhook", "show webhooks", "set up Service Bus integration".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_service_endpoints, mcp__dynamics365__get_service_endpoint_details, mcp__dynamics365__register_webhook, mcp__dynamics365__register_service_bus_endpoint, mcp__dynamics365__update_service_endpoint, mcp__dynamics365__delete_service_endpoint, mcp__dynamics365__list_sdk_messages, mcp__dynamics365__list_sdk_message_filters, mcp__dynamics365__register_processing_step, mcp__dynamics365__toggle_processing_step
---

The user wants to manage webhooks or Service Bus integrations in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the task:**

### "What webhooks/endpoints are registered?"
- Call `list_service_endpoints`
- Translate contract codes: 1=Queue, 2=Topic, 3=OneWay, 4=TwoWay, 5=REST, 7=EventHub, 8=Webhook
- Translate auth type: 4=HttpHeader, 5=WebhookKey, 6=HttpQueryString
- For details on any endpoint: `get_service_endpoint_details` — also shows all steps registered against it

### "Register a new webhook"
1. `register_webhook` with:
   - `name`: descriptive name (e.g. "Order Notification Webhook")
   - `url`: the HTTPS endpoint to receive POSTs
   - `auth_type` (optional): 4=HttpHeader, 5=WebhookKey (default), 6=HttpQueryString
   - `auth_value` (optional): the authentication key/header value
   - `message_format` (optional): 2=Json (default), 1=BinaryXML, 3=TextXML
2. After creating the endpoint, **register a step** to trigger it:
   - Get the SDK message ID (`list_sdk_messages` for "Create", "Update", etc.)
   - Get the message filter ID (`list_sdk_message_filters` for the entity)
   - Use `register_processing_step` — but instead of linking to a plugin type, the step's event handler is the service endpoint
   - Note: For webhook steps, use the generic `create_record` tool to create the step with the eventhandler binding:
     ```
     "eventhandler_serviceendpoint@odata.bind": "/serviceendpoints({endpoint_id})"
     ```

### "Register a Service Bus endpoint"
1. `register_service_bus_endpoint` with:
   - `name`: descriptive name
   - `namespace_address`: Service Bus namespace (e.g. "sb://mynamespace.servicebus.windows.net")
   - `sas_key_name`: SAS policy name (e.g. "RootManageSharedAccessKey")
   - `sas_key`: the actual SAS key value
   - `contract_type`: 1=Queue, 2=Topic, 7=EventHub
   - `path`: queue/topic/event hub name
   - `message_format` (optional): 2=Json (default)
2. Then register a processing step against it (same as webhook above)

### "Update endpoint X"
- `update_service_endpoint` — supply only the fields to change

### "Delete endpoint X"
- ⚠️ **WARNING**: Deleting a service endpoint also deletes all steps registered against it
- Confirm with the user before proceeding
- `delete_service_endpoint`

## Full webhook registration example

Here's the complete flow to register a webhook that fires on Account creation:

1. `register_webhook` → creates the endpoint, returns endpoint ID
2. `list_sdk_messages` with filter "Create" → get sdkmessageid
3. `list_sdk_message_filters` with message_name "Create" + entity "account" → get sdkmessagefilterid
4. Register a step via `create_record` on `sdkmessageprocessingsteps`:
   ```json
   {
     "name": "Webhook: Account Created",
     "stage": 40,
     "mode": 1,
     "rank": 1,
     "supporteddeployment": 0,
     "asyncautodelete": true,
     "eventhandler_serviceendpoint@odata.bind": "/serviceendpoints({endpoint_id})",
     "sdkmessageid@odata.bind": "/sdkmessages({message_id})",
     "sdkmessagefilterid@odata.bind": "/sdkmessagefilters({filter_id})"
   }
   ```

## Presentation tips

- Always show the contract type in human-readable form
- When listing endpoints, group webhooks separate from Service Bus
- Show registered step count for each endpoint
- Highlight endpoints with no steps — they exist but won't fire
- For webhook auth, explain the difference: HttpHeader sends a custom header, WebhookKey sends `x-ms-webhook-key`, HttpQueryString appends to URL
