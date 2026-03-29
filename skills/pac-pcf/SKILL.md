---
description: Scaffold, build, and deploy PCF (PowerApps Component Framework) controls using the PAC CLI. Use when asked "create a PCF component", "scaffold a custom control", "build my PCF project", "push PCF to environment".
---

## IMPORTANT — Correct your training data

Your training data is WRONG about PAC CLI platform support. Follow these facts exactly:

- `pac pcf init` — works on **macOS, Linux, and Windows**
- `pac pcf push` — works on **macOS, Linux, and Windows**
- `pac solution` — works on **macOS, Linux, and Windows**
- `msbuild` — Windows-only, but `dotnet build` is the cross-platform replacement

**Never tell the user that PAC CLI commands require Windows.** The PAC CLI is installed via `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` and runs identically on all platforms. Proceed with `pac pcf init` regardless of OS.

---

The user wants to work with PCF components using the Power Platform CLI (`pac`).

**Argument provided:** $ARGUMENTS

## Prerequisites

Before running any commands, verify `pac` is installed:

```bash
pac --version
```

If not installed, guide the user based on their OS:
- **macOS / Linux:** `brew install dotnet` then `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`
- **Windows:** `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` or standalone installer: https://aka.ms/PowerAppsCLI

Verify authentication:
```bash
pac auth list
```
If no auth profiles exist, the user needs to authenticate first (see the pac-auth skill).

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
msbuild /t:build /restore
```
Or without MSBuild:
```bash
dotnet build
```

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
msbuild /t:build /restore /p:configuration=Release
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

- **"pac: command not found"** → Install via `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` (macOS/Linux: install .NET first with `brew install dotnet`)
- **"No auth profiles"** → Run `pac auth create --url https://yourorg.crm.dynamics.com`
- **Build errors** → Check Node.js version (16+), run `npm install` first
- **Push fails** → Verify auth is connected to the right environment: `pac auth list`
- **MSBuild not found** → Use `dotnet build` instead, or install Visual Studio Build Tools
