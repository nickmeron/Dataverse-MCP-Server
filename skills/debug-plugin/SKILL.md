---
description: Debug plugin executions and troubleshoot errors using Plugin Trace Logs. Also discover and inspect Custom Actions and Custom APIs. Use when asked "what went wrong with...", "show me plugin errors", "find custom action X", "how do I call this API?".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__get_plugin_traces, mcp__dynamics365__find_custom_actions, mcp__dynamics365__get_custom_action_metadata, mcp__dynamics365__find_custom_apis, mcp__dynamics365__get_custom_api_metadata, mcp__dynamics365__execute_action, WebSearch
---

The user wants to debug a plugin issue, find errors, or understand custom actions/APIs.

**Argument provided:** $ARGUMENTS

## Plugin Trace Log Debugging

### "Something broke" / "Show me errors" / "Debug plugin X"
1. Call `get_plugin_traces` with the relevant filter:
   - By plugin name: `plugin_type_name: "MyPlugin"`
   - By correlation ID: `correlation_id: "abc-123"`
   - By message: `message_name: "Create"`
   - Adjust `hours_back` if needed (default 24h)
2. Analyze the results:
   - **performanceexecutionduration** → how long it ran (in ms)
   - **exceptiondetails** → the error message and stack trace
   - **messageblock** → trace output written by the plugin (ITracingService)
   - **depth** → execution pipeline depth (>1 means triggered by another plugin)
   - **mode** → 0=Synchronous, 1=Asynchronous
   - **operationtype** → which pipeline stage (0=Unknown, 1=Create, 2=Update, 3=Delete, etc.)
3. Present findings:
   - Highlight the error message clearly
   - Show the execution timeline
   - If there are patterns (e.g. all failures are async, or all from the same plugin), point that out
   - Suggest possible fixes based on the exception type

### Common plugin error patterns
- **InvalidPluginExecutionException** → business logic validation failure
- **System.NullReferenceException** → plugin code bug (null context?)
- **System.ServiceModel.FaultException** → permission or API error
- **Timeout** → long-running plugin hitting the 2-minute limit

## Custom Action & API Discovery

### "What custom actions exist?" / "Find action X"
1. Call `find_custom_actions` with a keyword
2. For each result, note: name, unique name, bound entity, status

### "How do I call custom action X?"
1. Call `get_custom_action_metadata` with the unique name
2. It returns:
   - The action definition (input parameters from XAML)
   - Registered plugin steps (if any)
   - **Web API invocation pattern** — the exact POST URL to call it
3. Present a clear example of how to call it via the Web API

### "What Custom APIs are available?"
1. Call `find_custom_apis` with a keyword
2. For detailed info: `get_custom_api_metadata` returns:
   - Request parameters (name, type, required/optional)
   - Response properties (name, type)
   - Plugin type that handles it
   - Whether it's a Function (GET) or Action (POST)
   - **Web API invocation pattern**

### If the user wants to actually execute an action
- Use the `execute_action` tool with the action name and parameters
- For bound actions, also provide the entity and entity_id

## Research support
If the error or pattern is unclear, search Microsoft Learn for the specific error message or pattern:
- `site:learn.microsoft.com plugin trace log {error_type}`
- `site:learn.microsoft.com custom api dataverse {topic}`
