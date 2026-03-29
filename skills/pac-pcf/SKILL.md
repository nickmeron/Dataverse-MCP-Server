---
description: Scaffold, build, and deploy PCF (PowerApps Component Framework) controls using the PAC CLI. Use when asked "create a PCF component", "scaffold a custom control", "build my PCF project", "push PCF to environment".
---

The user wants to work with PCF components using the Power Platform CLI (`pac`).

**Argument provided:** $ARGUMENTS

## Prerequisites — Install PAC CLI

All `pac` commands (`pac pcf init`, `pac pcf push`, `pac solution`) work on **macOS, Linux, and Windows**. Do not tell the user otherwise.

**Step 1 — Check if pac is already installed:**
```bash
pac help
```
If this prints the command list, skip to Step 3.

**Step 2 — Install pac (if not found):**

Detect the OS and run the matching commands:

**macOS / Linux:**
```bash
# Requires .NET 9+
dotnet --version
# If dotnet is not installed: brew install dotnet

# PAC CLI 2.x has a broken NuGet package on macOS — use 1.52.1
dotnet tool install --global Microsoft.PowerApps.CLI.Tool --version 1.52.1
```

**Windows:**
```bash
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```
Or use the standalone MSI installer: https://aka.ms/PowerAppsCLI

**Step 3 — Authenticate pac:**
```bash
pac auth list
```
If no profiles exist, check whether the user already authenticated via the MCP `authenticate` tool. If so, reuse those credentials to create a pac profile automatically:
```bash
pac auth create \
  --name MCP \
  --url ACTIVE_ENVIRONMENT_URL \
  --applicationId MCP_CLIENT_ID \
  --clientSecret "MCP_CLIENT_SECRET" \
  --tenant MCP_TENANT_ID
```
Replace the values with the credentials the user provided to the MCP `authenticate` tool. This avoids asking the user to authenticate twice.

If the user has NOT authenticated via MCP either, use the pac-auth skill.

## Workflows

### "Create a new PCF component"

1. **Initialize the project:**
```bash
mkdir MyControl && cd MyControl
pac pcf init --namespace Contoso --name MyControl --template field
```
- `--template field` for field-level controls (bound to a single field)
- `--template dataset` for dataset controls (grids, galleries)
- `--namespace` should match the publisher prefix (e.g. `Contoso`, `MyCompany`)
- `--framework react` to use React framework (optional but recommended)

With React:
```bash
pac pcf init --namespace Contoso --name MyControl --template field --framework react
```

2. **Install dependencies:**
```bash
npm install
```

3. **Key files to edit:**
- `MyControl/index.ts` — Main control logic (init, updateView, destroy)
- `ControlManifest.Input.xml` — Declares properties, resources, feature usage
- For React: `MyControl/HelloWorld.tsx` — React component

4. **Build and test locally:**
```bash
npm run build
npm start watch
```
This opens a test harness at `http://localhost:8181` with hot reload.

5. **Push to environment (dev iteration):**
```bash
pac pcf push --publisher-prefix contoso
```
This creates a temporary solution and pushes to the connected environment. Quick for dev, not for production.

6. **Package for solution deployment:**
```bash
mkdir Solution && cd Solution
pac solution init --publisher-name Contoso --publisher-prefix contoso
pac solution add-reference --path ../MyControl
dotnet build
```
On Windows you can also use `msbuild /t:build /restore` instead of `dotnet build`.

### "Build and test an existing PCF project"

```bash
cd /path/to/pcf-project
npm install
npm run build        # one-time build
npm start watch      # dev server with hot reload
```

### "Add a new property to my PCF control"

Edit `ControlManifest.Input.xml`:
```xml
<property name="myNewProp" display-name-key="My New Property"
  description-key="Description" of-type="SingleLine.Text"
  usage="bound" required="true" />
```

Common `of-type` values:
- `SingleLine.Text`, `Multiple`, `WholeNumber`, `Decimal`, `Currency`
- `DateAndTime.DateOnly`, `DateAndTime.DateAndTime`
- `TwoOptions` (boolean), `OptionSet`, `Lookup.Simple`
- `FP` (floating point)

Then rebuild: `npm run build`

### "Deploy PCF to production via solution"

1. Build the solution:
```bash
cd Solution
dotnet build --configuration Release
```
2. The `.zip` file is in `Solution/bin/Release/`
3. Import via the admin portal or using the MCP's `import_solution` tool (base64 encode the zip first)

## ControlManifest.Input.xml reference

```xml
<?xml version="1.0" encoding="utf-8" ?>
<manifest>
  <control namespace="Contoso" constructor="MyControl" version="1.0.0"
    display-name-key="MyControl" description-key="Description"
    control-type="standard">

    <!-- Bound property -->
    <property name="value" display-name-key="Value"
      of-type="SingleLine.Text" usage="bound" required="true" />

    <!-- Input-only property -->
    <property name="label" display-name-key="Label"
      of-type="SingleLine.Text" usage="input" required="false"
      default-value="Default Label" />

    <!-- Dataset (for dataset template only) -->
    <data-set name="dataSet" display-name-key="DataSet" />

    <resources>
      <code path="index.ts" order="1" />
      <css path="css/MyControl.css" order="1" />
      <resx path="strings/MyControl.1033.resx" version="1.0.0" />
    </resources>

    <!-- Feature usage declarations -->
    <feature-usage>
      <uses-feature name="Device.captureImage" required="true" />
      <uses-feature name="Utility" required="true" />
      <uses-feature name="WebAPI" required="true" />
    </feature-usage>
  </control>
</manifest>
```

## Common patterns

### Access Web API from PCF
```typescript
// In updateView or init:
const result = await this._context.webAPI.retrieveMultipleRecords(
  "account", "?$select=name&$top=10"
);
```

### Use React in PCF
```typescript
// index.ts
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { MyComponent } from "./MyComponent";

export class MyControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _root: Root;

  public init(context, notifyOutputChanged, state, container) {
    this._root = createRoot(container);
  }

  public updateView(context) {
    this._root.render(React.createElement(MyComponent, { value: context.parameters.value.raw }));
  }

  public destroy() { this._root.unmount(); }
}
```

## Troubleshooting

- **"pac: command not found"** → See install steps above. macOS requires `--version 1.52.1`.
- **"DotnetToolSettings.xml not found"** → You're installing PAC 2.x on macOS. Use `--version 1.52.1` instead.
- **"No auth profiles"** → Run `pac auth create` or use the pac-auth skill
- **Build errors** → Check Node.js version (16+), run `npm install` first
- **Push fails** → Verify auth is connected to the right environment: `pac auth list`
- **MSBuild not found** → Use `dotnet build` instead (works on all platforms)
