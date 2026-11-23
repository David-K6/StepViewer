# StepViewer

A lightweight STEP / IGES / BREP / **SolidWorks (SLDPRT, SLDASM)** / **Parasolid (X_T)** / **URDF robot** / STL / OBJ viewer. It runs from a single executable: `dist\StepViewer.exe`. Robot joints can be moved, and agents such as Claude Code can drive the viewer over [MCP](#automation-over-mcp-claude-code-and-other-agents).

## Running it

- Double-click `dist\StepViewer.exe`. The viewer opens in a frameless Edge (or Chrome) app window. No installation is needed and it works fully offline.
- `StepViewer.exe a.step b.SLDASM robot.urdf` opens each file in its own tab.
- "+ 열기" (Ctrl+O) shows the Windows open dialog. Several files can be picked at once; files referenced by an assembly or URDF (its parts / meshes) are read from next to it, so picking the `.SLDASM` or `.urdf` alone is enough. Part or mesh files picked together with an assembly or URDF only serve as its references (no tab of their own), like files dropped together; files passed on the command line or opened from Explorer each get a tab.
- If StepViewer is already running, launching it again opens the new files as tabs in the existing window instead of starting a second copy.
- To open `.step`, `.sldprt`, `.sldasm`, `.x_t`, `.urdf` or `.stl` files by double-clicking them, set StepViewer.exe as the default app for that file type in Windows' "Open with" dialog.
- StepViewer quits automatically once the last viewer window is closed. The log is written to `%TEMP%\StepViewer.log`.
- **Updates:** "업데이트 확인" (top right) compares the running version with the latest GitHub release. If a newer one exists, "업데이트" downloads it, replaces `StepViewer.exe` in place and restarts (open files are closed; the window reloads itself). The exe's folder must be writable; otherwise download it from the releases page. Versions before 0.0.4 have no updater, so install 0.0.4 once by hand.

## Web version

The same viewer runs in the browser at **https://david-k6.github.io/StepViewer/** with nothing to install. Files are parsed inside the browser and are never uploaded; parsed models are cached in the browser (IndexedDB).

- Open files with the 열기 button, Ctrl+O or drag and drop. For a SolidWorks assembly, select (or drop) the `.SLDASM` together with its part files, because a web page cannot read the files next to it. The same goes for a `.urdf` and its mesh files.
- Not available on the web: opening files by double-click / "Open with", and the in-app updater (the web version is always the latest release). The "데스크톱 앱 받기" button links to the exe.
- On phones (narrower than 820 px, or landscape under 520 px tall) the layout changes: ☰ opens the model tree as a drawer, ⋮ holds quality / update / help, the tools sit in one scrollable row at the bottom and panels become sheets (tap a sheet's title to fold it). One finger rotates, two fingers zoom and pan, a tap selects (tap a selected part again to pick a face, edge or vertex) and a long press opens the menu (hide, rotation center, normal view, DXF).
- It is published by `.github/workflows/pages.yml` on every push to `main` that touches the app (or run it by hand from the Actions tab).

## Features

| Feature | How to use it |
|---|---|
| Multiple files as tabs | Drag and drop files, use "+ 열기" (Open) or Ctrl+O. Switch tabs with Ctrl+Tab and close one with Ctrl+W. |
| Rotate / pan / zoom | Left drag rotates freely (no limit at the poles, the model can be turned over). Right or middle drag (or Shift+left drag) pans. The wheel zooms toward the cursor. Double-click sets the rotation center. The world origin is marked with small X/Y/Z arms (toggle with O). |
| Views | Fit (F), isometric (0), front (1), right (3), top (7). Hold Ctrl for the opposite side. P toggles perspective/orthographic. |
| Show / hide parts | Click the eye icon in the tree, H (hide the selection), I (isolate the selection), Shift+H (show everything). Right-click a part or a tree row for a menu: hide the selection, hide everything else (the camera stays put), show all. |
| Transparency | Per part: select it and use the transparency slider. Whole model: the "전체 투명도" (overall transparency) slider. |
| Section view | X opens the panel. Each of the X, Y and Z planes can be turned on and moved separately (slider, number, or left-drag the blue plane in the view while the panel is open), and you can also define a plane by picking a face. Cut faces are filled solid (stencil caps) and part boundaries on them are drawn as lines. |
| Measurement | Distance (D), angle (A), radius/diameter (R: click a round edge or a cylindrical / partial cylindrical face, or pick 3 points), face area and normal (G). Snaps to vertices and edges; hold Shift to turn snapping off. Shift+C clears all measurements and the selection. |
| Pick faces / edges / vertices | Click a selected part again to pick the face, edge or vertex under the cursor (click it again to release it). One pick shows its data: face area and plane normal or cylinder radius, edge length and line direction or arc radius, vertex coordinates. A second pick (on the same part, or on another part selected with Ctrl+click) shows the shortest distance with ΔX/ΔY/ΔZ, the angle between planes or lines, the distance between parallel planes, lines or cylinder axes and between circle centers. "측정에 추가" keeps it in the measurement list; Esc releases the picks. |
| Robot joints (URDF) | J opens the joint panel: a slider and number box per joint (deg / mm) within the URDF limits, "한계 무시" to lift them, "초기화" for the start pose. Hover a row to see its axis; click a joint name to select what it moves. See [URDF robots](#urdf-robots-and-stl--obj). |
| Face actions | Right-click a picked face: "면에 수직으로 보기" turns the view to look straight at it. For a plane, "DXF로 내보내기…" writes the face outline seen from its front (LINE / ARC / CIRCLE, holes included) in mm, cm, m, µm, inch or ft to the folder and file name you choose. In the web version the browser's save dialog is used. |

## Parasolid files (X_T)

Text transmit files (`.x_t`, `.xmt_txt`) from current Onshape, SolidWorks, NX and other Parasolid-based systems open directly. The binary form (`.x_b`) is not supported.

- The B-rep (planes, cylinders, cones, spheres, tori, B-spline and swept surfaces; lines, circles, ellipses, B-spline curves) is converted to STEP in the worker and tessellated by OpenCascade like a STEP file. Edges stored only as surface-parametric or intersection curves are approximated to within 1 µm.
- Each Parasolid body becomes a part. Names and colors come from the file's attributes; `part__body` and `a/b/c` body names become the tree.
- Checked against STEP exports of the same parts: face count, surface area and bounding box are identical. A 24 MB, 621-body Onshape assembly opens in about 15 s (then from the cache), and every solid in it tessellates closed.
- Not supported yet: blend (rolling-ball) and spun surfaces; faces on them are skipped with a warning.

## URDF robots (and STL / OBJ)

A `.urdf` opens as a robot whose joints can be moved.

- **Meshes:** STL (binary or ASCII) and OBJ visuals, plus `box`, `cylinder`, `sphere` and `capsule` shapes. Mesh `scale`, visual origins and `<material>` colors (alpha = transparency) are applied; units are converted from meters to mm. Collision geometry is not shown.
- **Finding the mesh files:** only files below the URDF's parent folder are read (the ROS layout `<pkg>/urdf/x.urdf` + `<pkg>/meshes/`). A `package://my_robot_description/meshes/base.stl` reference is resolved against the folder named like the package first, a relative path (`../meshes/base.stl`) against the URDF's folder; failing that, the bare file name is looked up next to the URDF and in `meshes/` folders. Names must match exactly. In the desktop app the 열기 button (and Ctrl+O) shows the Windows open dialog, so picking the `.urdf` alone is enough; mesh files picked together with it are used too (also from other folders; same-named ones are told apart by their package path). Dropping a file gives no folder, so drop the URDF together with its meshes. In the web version select (or drop) the URDF together with its mesh files; they are matched by file name. Missing meshes are listed in a warning and the rest of the robot still opens.
- **Joints panel** (⟲ 관절, key J): one slider and number box per movable joint (revolute and continuous in degrees, prismatic in mm), in URDF order. Sliders stop at the URDF limits; "한계 무시" lifts them. `<mimic>` joints follow their master (and stop at their own limits) and are shown greyed out. A joint with `lower` = `upper` stays locked at that value. "초기화" returns to the start pose: every joint at 0, or at the nearest limit when 0 is outside its limits. Hovering a row draws that joint's axis; clicking its name selects everything the joint moves.
- **Model tree** = kinematic tree (link inside its parent link). Measurement, sections, picking faces/edges and DXF work on the current pose. Picked faces/edges of a link that moves are released; finished measurements stay where they were taken.
- Mesh triangles are split into faces (planar regions, and smooth regions bounded by edges sharper than 30°), which also gives the CAD edges and smooth shading.
- Not supported: `.xacro` (run `xacro` first), COLLADA (`.dae`) meshes, `floating` / `planar` joints (shown fixed), closed kinematic loops.
- A `.stl` or `.obj` file opened on its own becomes a single part, its numbers taken as mm.

## SolidWorks files (SLDPRT / SLDASM)

No SolidWorks installation is needed. StepViewer reads the display tessellation that SolidWorks stores inside the file, so there is no OpenCascade step and loading is fast (a 28 MB assembly opens in about 1 s).

- **Parts (.SLDPRT):** faces come from the part's display data (`DisplayLists`). Face count and size match a STEP export of the same part (surface area within 0.01%), and measurement, sections and CAD edges work as usual.
- **Assemblies (.SLDASM):** the component tree (positions, rotations, hidden and suppressed states) and the per-component display data are both stored in the assembly, so **the assembly file alone** is enough.
  - Hidden components open hidden and suppressed ones are left out.
  - A component with no display data in the assembly is read from a **part file in the same folder** (Pack and Go's `_date` suffix is recognized) or, for components inserted with 3D Interconnect, from the **original STEP file**. When dragging and dropping, drop the assembly together with its part files.
- Limitations
  - Files saved before SolidWorks 2015 (OLE format) are not supported.
  - Tessellation quality is whatever SolidWorks saved (the quality setting has no effect). Vertices lie on the true surface, so vertex and edge snapping is exact; points in the middle of curved faces can be off by a few tens of µm.
  - Colors: each part shows its SolidWorks appearance color (part-level, or as stored per file in the assembly). Face- and feature-level appearances, textures and transparency are not read, and cosmetic threads are not shown.
  - A part saved without display data (Parasolid geometry only) can't be opened on its own. Inside an assembly it still shows, from the assembly's data.

## Performance

- STEP parsing runs in a Web Worker using OpenCascade WASM, so the UI never freezes while a file loads.
- Each parsed result is cached in IndexedDB, keyed by a SHA-256 hash of the file contents. Reopening a file takes under a second.
- Rendering only happens when something changes. All CAD edges are merged into one draw call, and picking uses a BVH.
- While you rotate or pan, resolution is lowered automatically if frames start to slow down.
- Measured on an AMD Radeon 840M with a 556-part, 440k-triangle assembly: rotation runs at about 60 fps.
- The first parse of a large STEP file is slow: about 55 s for 30 MB and about 75 s for 78 MB. That time is spent inside OCCT's single-threaded read/transfer stage.

## Automation over MCP (Claude Code and other agents)

`StepViewer.exe --mcp` is an [MCP](https://modelcontextprotocol.io) server on stdin/stdout. An agent can open files, read the model, move robot joints, cut sections and look at the result, in the viewer window on this PC: the user sees everything it does, and the joint panel, tree and sections show the same state.

### Connecting

1. Use a StepViewer that has `--mcp` (this version or later). **Close an older StepViewer that is still running**: the MCP server talks to the running instance, and an older one answers "older version without automation".
2. Register it with Claude Code (once, for all projects):
   ```
   claude mcp add stepviewer -s user -- "C:\path\to\StepViewer.exe" --mcp
   claude mcp list          # stepviewer: ... - ✓ Connected
   ```
   Other MCP clients (Claude Desktop, Cursor, ...): command `C:\path\to\StepViewer.exe`, argument `--mcp`, transport stdio. For example in `claude_desktop_config.json`:
   ```json
   { "mcpServers": { "stepviewer": { "command": "C:\\path\\to\\StepViewer.exe", "args": ["--mcp"] } } }
   ```
3. In this repository `.mcp.json` already registers the development version (`node server.js --mcp`, from the working tree; run `npm install` and `npm run vendor` once). Claude Code asks once whether to allow it.

If the viewer is not running, the first tool call starts it and opens its window. Commands go to the viewer window the user used last.

### Examples (what to ask the agent)

- "Open C:\robots\hand\hand.urdf and show me all joints with their limits."
- "Bend index_mcp to 60° and index_pip to 45°, look from the front and take a screenshot."
- "Open part.step, cut it at x = 12 mm and tell me the bounding box of the bracket."
- "Close the hand step by step and check that no finger passes its limit."

A typical sequence: `open_files` → `get_joints` → `set_joints` → `set_view` → `screenshot`. Lengths are in mm and angles in degrees, in the model's world coordinates.

### Tools

| Tool | What it does |
|---|---|
| `viewer_status` | open tabs: parts, triangles, bounding box (mm), robot joints |
| `open_files` | open files by absolute path (all formats the viewer opens); referenced parts / meshes are found next to them; rejected paths are listed |
| `manage_tab` | activate or close a tab (by name or `#index`) |
| `get_model` | parts (name, URDF link, visibility, selection, triangles, bounding box), with a name filter |
| `get_joints` | URDF joints: type, value (deg / mm), URDF limits, usable range, home value, parent / child link, axis, mimic |
| `set_joints` | set several joints at once (`{"index_mcp": 45}`), `reset` to the start pose, `ignore_limits`; values outside the range are clamped and reported; mimic joints follow their master |
| `set_view` | iso / front / back / left / right / top / bottom / fit, optionally fitted to some parts |
| `set_visibility` / `select_parts` | show, hide, show only, show all; select (an empty list clears) |
| `set_section` | section plane normal to x / y / z at a position in mm (flip, caps), or off |
| `screenshot` | PNG of the 3D view as it is shown (longest side up to 4096 px) |

The tools that work on one tab (`get_model`, `get_joints`, `set_joints`, `set_view`, `set_visibility`, `select_parts`, `set_section`, `screenshot`) take an optional `tab` (name or `#index`, default: the active tab); `manage_tab` requires it. Arguments are checked against each tool's schema (unknown or misspelt arguments are refused). Cancelling `open_files` closes the tabs it opened, even while they are still loading; changes made by other tools (joints, visibility, section, view) take effect immediately and stay.

### How it works / security

- `--mcp` runs a small MCP server (`mcp.js`, embedded in the exe) that finds the running viewer through `%LOCALAPPDATA%\StepViewer\instance.json` and sends each call to the local server's `/api/rpc`. The server passes it to the viewer window over its event stream; the window runs it and posts the result back.
- The local server only answers requests addressed to `127.0.0.1` / `localhost` (no DNS rebinding), and `/api/rpc` also needs the app's own header, so web pages cannot use it. Files opened over MCP must be absolute paths of supported types that exist.
- Test: `npm run mcptest -- robot.urdf` (with `MCP_EXE=dist/StepViewer.exe` it tests the built exe).

## Development

```
npm install
npm start            # dev server (serves app/ from disk)
npm run build        # dist/StepViewer.exe (Node SEA, GUI subsystem)
npm run smoke -- testfiles/x.stp   # headless Edge test with assertions
npm run swtest -- a.SLDASM --pair p.SLDPRT=p.step   # SolidWorks reader regression test
npm run xttest -- a.x_t --ref a.step                 # Parasolid reader regression test
npm run web          # build/web: static web version (what GitHub Pages serves)
npm run webtest      # headless test of build/web served under /StepViewer/
npm run mobiletest   # phone/tablet layouts and touch gestures (8 screen sizes, headless Edge)
npm run urdftest -- robot.urdf   # URDF: loading, forward kinematics vs. an independent computation, joint panel
npm run mcptest -- robot.urdf    # MCP server over stdio driving a headless window (MCP_EXE=dist/StepViewer.exe: the exe)
```

Releasing: set `version` in package.json, build, then create a GitHub release whose tag is exactly that version (e.g. `0.0.4`) with the exe attached as `StepViewer.exe`. The in-app updater relies on both. The web version is republished from `main` automatically.
