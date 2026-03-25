---
description: Pack, unpack, clone, and manage Dynamics 365 solutions using the PAC CLI. Use when asked "unpack solution", "pack solution", "clone solution", "source control my solution", "compare solution files".
---

The user wants to work with solutions using the Power Platform CLI (`pac`).

**Argument provided:** $ARGUMENTS

## Prerequisites

Verify `pac` is installed and authenticated:
```bash
pac --version
pac auth list
```

## Workflows

### "Unpack a solution" (for source control)

This decomposes a solution .zip into individual XML/JSON files that can be version-controlled.

```bash
pac solution unpack --zipfile ./MySolution.zip --folder ./MySolution-unpacked
```

Options:
- `--packagetype Unmanaged` (default) / `Managed` / `Both`
- `--allowDelete true` — Remove files from target folder that aren't in the zip
- `--allowWrite true` — Overwrite existing files
- `--localize` — Extract localized labels into separate RESX files
- `--map mapfile.xml` — Use a mapping file for file organization
- `--sourceLoc auto` — Extract source locale strings

**Typical source control workflow:**
```bash
# Export from environment (use MCP export_solution tool or pac)
pac solution export --name MySolution --path ./MySolution.zip --managed false

# Unpack for source control
pac solution unpack --zipfile ./MySolution.zip --folder ./src/MySolution

# Commit to git
cd ./src/MySolution
git add -A
git commit -m "Export MySolution v1.2.3"
```

### "Pack a solution" (from source files)

Reassembles unpacked source files into a deployable .zip:

```bash
pac solution pack --folder ./MySolution-unpacked --zipfile ./MySolution.zip
```

Options:
- `--packagetype Unmanaged` / `Managed` / `Both`
- `--localize` — Include localized content
- `--map mapfile.xml` — Use mapping file

**Deployment workflow:**
```bash
# Pack from source
pac solution pack --folder ./src/MySolution --zipfile ./MySolution_managed.zip --packagetype Managed

# Import to target (use MCP import_solution or pac)
pac solution import --path ./MySolution_managed.zip --activate-plugins
```

### "Clone a solution" (create a local project linked to environment)

Creates a VS project that can build the solution:

```bash
pac solution clone --name MySolution --outputDirectory ./MySolution-project
```

This creates a `.cdsproj` file you can build with:
```bash
cd MySolution-project
dotnet build
```

The built .zip appears in `bin/Debug/` or `bin/Release/`.

### "Compare solutions across environments"

Use the MCP tools for API-based comparison, plus `pac` for file-level diffs:

1. Export from both environments:
```bash
pac auth select --index 1  # DEV
pac solution export --name MySolution --path ./dev-export.zip --managed false

pac auth select --index 2  # UAT
pac solution export --name MySolution --path ./uat-export.zip --managed false
```

2. Unpack both:
```bash
pac solution unpack --zipfile ./dev-export.zip --folder ./dev-unpacked
pac solution unpack --zipfile ./uat-export.zip --folder ./uat-unpacked
```

3. Diff:
```bash
diff -rq ./dev-unpacked ./uat-unpacked
# Or use git diff:
git diff --no-index ./dev-unpacked ./uat-unpacked
```

### "Check solution for issues"

```bash
pac solution check --path ./MySolution.zip
```

This runs the Solution Checker (Power Apps checker) and returns warnings/errors about:
- Deprecated API usage
- Performance issues
- Security concerns
- Web resource best practices

Options:
- `--outputDirectory ./results` — Save results to a folder
- `--ruleset solution-checker` — Specify ruleset
- `--geo Europe` — Specify geography for the checker service

### "Sync solution from environment" (pull latest changes)

```bash
pac solution sync --solution-folder ./src/MySolution --packagetype Unmanaged
```

This exports from the connected environment and unpacks in one step. Equivalent to export + unpack.

## Unpacked solution structure

After unpacking, you'll see:
```
MySolution/
├── Other/
│   ├── Customizations.xml          # Main customization file
│   ├── Solution.xml                # Solution metadata
│   └── Relationships.xml           # Entity relationships
├── Entities/
│   ├── account/
│   │   ├── Entity.xml
│   │   ├── FormXml/
│   │   │   └── main/
│   │   │       └── {guid}.xml      # Forms
│   │   ├── SavedQueries/
│   │   │   └── {guid}.xml          # Views
│   │   └── RibbonDiff.xml
│   └── contact/
│       └── ...
├── OptionSets/                     # Global option sets
├── Workflows/                      # Cloud flows + workflows
├── PluginAssemblies/               # Plugin DLLs (base64)
├── WebResources/                   # JS, HTML, CSS, images
├── Roles/                          # Security roles
├── SiteMap/                        # App site maps
└── CanvasApps/                     # Canvas app packages
```

## Mapping file for custom folder structure

Create a `map.xml` to control unpacking layout:
```xml
<?xml version="1.0" encoding="utf-8"?>
<Mapping>
  <FileToPath map="Entities/account/*.xml" to="entities\account" />
  <FileToPath map="WebResources/*.js" to="webresources\scripts" />
  <FileToPath map="WebResources/*.css" to="webresources\styles" />
  <FileToPath map="WebResources/*.html" to="webresources\pages" />
  <FileToPath map="Workflows/*.json" to="flows" />
</Mapping>
```

Use with: `pac solution unpack --map map.xml ...`

## CI/CD integration

For Azure DevOps / GitHub Actions:
```yaml
# GitHub Actions example
- name: Install PAC
  run: npm install -g pac-cli

- name: Auth
  run: pac auth create --url ${{ secrets.D365_URL }} --applicationId ${{ secrets.CLIENT_ID }} --clientSecret ${{ secrets.CLIENT_SECRET }} --tenant ${{ secrets.TENANT_ID }}

- name: Export
  run: pac solution export --name MySolution --path ./solution.zip

- name: Pack managed
  run: pac solution pack --folder ./src/MySolution --zipfile ./managed.zip --packagetype Managed

- name: Import to target
  run: |
    pac auth create --url ${{ secrets.TARGET_URL }} --applicationId ${{ secrets.CLIENT_ID }} --clientSecret ${{ secrets.CLIENT_SECRET }} --tenant ${{ secrets.TENANT_ID }}
    pac solution import --path ./managed.zip --activate-plugins
```

## Troubleshooting

- **"Solution not found"** → Check the unique name (not display name): `pac solution list`
- **Unpack fails on large solutions** → Increase timeout: `pac solution unpack --processCanvasApps`
- **Pack produces empty zip** → Verify folder structure matches expected layout
- **Check fails** → Ensure you have the right geography set: `--geo Europe` for EMEA orgs
