# StepViewer

A lightweight STEP / IGES / BREP / **SolidWorks (SLDPRT, SLDASM)** viewer. It runs from a single executable: `dist\StepViewer.exe`.

## Running it

- Double-click `dist\StepViewer.exe`. The viewer opens in a frameless Edge (or Chrome) app window. No installation is needed and it works fully offline.
- `StepViewer.exe a.step b.SLDASM` opens each file in its own tab.
- If StepViewer is already running, launching it again opens the new files as tabs in the existing window instead of starting a second copy.
- To open `.step`, `.sldprt` or `.sldasm` files by double-clicking them, set StepViewer.exe as the default app for that file type in Windows' "Open with" dialog.
- StepViewer quits automatically once the last viewer window is closed. The log is written to `%TEMP%\StepViewer.log`.

## Features

| Feature | How to use it |
|---|---|
| Multiple files as tabs | Drag and drop files, use "+ 열기" (Open) or Ctrl+O. Switch tabs with Ctrl+Tab and close one with Ctrl+W. |
| Rotate / pan / zoom | Left drag rotates. Right or middle drag (or Shift+left drag) pans. The wheel zooms toward the cursor. Double-click sets the rotation center. |
| Views | Fit (F), isometric (0), front (1), right (3), top (7). Hold Ctrl for the opposite side. P toggles perspective/orthographic. |
| Show / hide parts | Click the eye icon in the tree, H (hide the selection), I (isolate the selection), Shift+H (show everything). Right-click a part or a tree row for a menu: hide the selection, hide everything else (the camera stays put), show all. |
| Transparency | Per part: select it and use the transparency slider. Whole model: the "전체 투명도" (overall transparency) slider. |
| Section view | X opens the panel. Each of the X, Y and Z planes can be turned on and moved separately, and you can also define a plane by picking a face. Cut faces are filled solid (stencil caps) and part boundaries on them are drawn as lines. |
| Measurement | Distance (D), angle (A), radius/diameter (R: click a round edge, or pick 3 points), face area and normal (G). Snaps to vertices and edges; hold Shift to turn snapping off. |

## SolidWorks files (SLDPRT / SLDASM)

No SolidWorks installation is needed. StepViewer reads the display tessellation that SolidWorks stores inside the file, so there is no OpenCascade step and loading is fast (a 28 MB assembly opens in about 1 s).

- **Parts (.SLDPRT):** faces come from the part's display data (`DisplayLists`). Face count and size match a STEP export of the same part (surface area within 0.01%), and measurement, sections and CAD edges work as usual.
- **Assemblies (.SLDASM):** the component tree (positions, rotations, hidden and suppressed states) and the per-component display data are both stored in the assembly, so **the assembly file alone** is enough.
  - Hidden components open hidden and suppressed ones are left out. Instances of the same part file share a color.
  - A component with no display data in the assembly is read from a **part file in the same folder** (Pack and Go's `_date` suffix is recognized) or, for components inserted with 3D Interconnect, from the **original STEP file**. When dragging and dropping, drop the assembly together with its part files.
- Limitations
  - Files saved before SolidWorks 2015 (OLE format) are not supported.
  - Tessellation quality is whatever SolidWorks saved (the quality setting has no effect). Vertices lie on the true surface, so vertex and edge snapping is exact; points in the middle of curved faces can be off by a few tens of µm.
  - SolidWorks appearances (colors, textures) are not read; each part file gets its own color. Cosmetic threads are not shown.
  - A part saved without display data (Parasolid geometry only) can't be opened on its own. Inside an assembly it still shows, from the assembly's data.

## Performance

- STEP parsing runs in a Web Worker using OpenCascade WASM, so the UI never freezes while a file loads.
- Each parsed result is cached in IndexedDB, keyed by a SHA-256 hash of the file contents. Reopening a file takes under a second.
- Rendering only happens when something changes. All CAD edges are merged into one draw call, and picking uses a BVH.
- While you rotate or pan, resolution is lowered automatically if frames start to slow down.
- Measured on an AMD Radeon 840M with a 556-part, 440k-triangle assembly: rotation runs at about 60 fps.
- The first parse of a large STEP file is slow: about 55 s for 30 MB and about 75 s for 78 MB. That time is spent inside OCCT's single-threaded read/transfer stage.

## Development

```
npm install
npm start            # dev server (serves app/ from disk)
npm run build        # dist/StepViewer.exe (Node SEA, GUI subsystem)
npm run smoke -- testfiles/x.stp   # headless Edge test with assertions
npm run swtest -- a.SLDASM --pair p.SLDPRT=p.step   # SolidWorks reader regression test
```
