# VRoid Super Converter

A Windows desktop app (Electron + three.js) with a 3D preview that converts any bipedal model or animation to the **VRoid skeleton**, and adds tools for fitting, posing, lip sync, IK, rig conversion, VRoid custom items and Project DIVA Mega Mix+ `.farc` merging.

## Getting the .exe

* **CI build:** every push runs `.github/workflows/build.yml`. The `windows-exe` job produces a portable `.exe` and an installer, uploaded as the `VRoidSuperConverter-windows` artifact. Tags named `v*` also attach them to a GitHub release.
* **Local build (Windows):** `npm ci` then `npm run dist:win`. The output goes to `release/`.
* **Run from source (any OS):** `npm ci` then `npm start`.

## What it does

| Area | Features |
| --- | --- |
| **Import** | VRM (0.x/1.0), GLB/glTF, FBX, OBJ, DAE, BVH, VRMA, plus audio (WAV/MP3/OGG/FLAC…), `.farc`, `.vroidcustomitem` and `.vroidpose`. You can drag files onto the viewport. Textures next to FBX/OBJ files are picked up automatically. |
| **Convert to VRoid skeleton** | **Rigged** models get their bones detected from names (Mixamo, Unity, Unreal/Tower Unite, VRoid, MMD Japanese names, Valve Biped, Blender/Rigify, 3ds Max Biped) and, failing that, from the skeleton's shape. The model is rebuilt on a clean `Root → J_Bip_C_Hips…` VRoid hierarchy with identity rest rotations, then posed into a T-pose and re-bound. Weights are remapped, and extra bones (hair, skirt) can be kept. Units and facing direction are fixed automatically. The bone-mapping table can be edited by hand. |
| **Auto-rig** | **Unrigged** models get joints estimated by slicing the mesh surface (crotch, neck, shoulders, arm tips, legs, feet). Skin weights come from bone-segment envelopes, constrained by body region and smoothed over the mesh. |
| **Animations** | Any humanoid animation is retargeted to the VRoid skeleton. This includes A-pose↔T-pose alignment, scaled root motion and an in-place option. |
| **Preview / timeline** | Play the animation on the VRoid model, scrub, step frame by frame, and loop. |
| **.vroidpose** | Export the current frame as a `.vroidpose`, or apply one to the model. |
| **Head & eyes** | Keep, remove, look around (seeded, adjustable range/speed/hold), or fixed direction (relative to the body or held in world space). Eyes can stay straight, look around alone (saccades), hold a fixed direction, or lead the head. The result is written as a new clip. |
| **Fit & shape** | Refit clothing onto the VRoid body with these settings: offset, tightness, max pull distance, push-out only, smoothing iterations/strength, collision passes, auto-align, XYZ scale/move, Y rotation, per-region offsets (torso/arms/legs/head/feet), and skin-weight transfer and smoothing. Proportion transfer works in either direction, with strength and limb-girth matching. |
| **Optimize** | Welds vertices of the same material that share a position. You can choose to keep UV seams or hard normals, and remove degenerate or duplicate triangles. Skin weights and morph targets are merged too. |
| **Shape keys** | Rename `Fcl_*` keys to readable names (`Eyes.Blink`, `Mouth.Joy`, `Viseme.A`…) and back. Add left/right versions of every shape key, with an adjustable blend width at the centre line. The tab also has preview sliders. |
| **IK** | Adds IK target and pole bones (`IK_Foot_L/R`, `IK_Hand_L/R`, knee/elbow poles, `IK_LookAt`) that export with the skeleton. Live two-bone IK with draggable gizmos, look-at, and baking leg IK into a clip with foot locking. |
| **Rig conversion** | Tower Unite (modern, UE4 mannequin naming), UE4 mannequin, UE5 Manny core, Mixamo, MMD (PMX standard bones), Unity humanoid, JSON rig profiles, or **any provided rig file**. With a provided rig, its bone names and orientations are kept, and you choose whether to keep the model's proportions or the rig's. Twist bones get weights distributed. |
| **Custom items** | Open a `.vroidcustomitem`. You can change its category within its family (hair / clothing / accessory), rename it, give it fresh item IDs, and replace embedded textures and the thumbnail. You can also bake another model's appearance onto the VRoid model's texture layout and inject the result into the item. |
| **Lip sync** | LPC formant analysis turns audio into VRoid visemes (`Fcl_MTH_A/I/U/E/O`), with adjustable thresholds, voice pitch, attack/release and gain. The result can be merged with a body animation and played back with the audio. |
| **Project DIVA MM+** | Import several `.farc` files (FArc, FArC, and encrypted FARC from DT and Future Tone), with optional `ext_skp_*.txt` skin parameters. Tick or untick any object, mesh or sub-mesh. Export one merged `.farc` (`_obj.bin` + `_tex.bin`), a regenerated `ext_skp_<object>.txt` skin parameter file so osage physics keeps working, and `mod_obj_db.bin`. With new texture IDs you also get `mod_tex_db.bin`. Bones are merged by name, sub-mesh bone palettes are remapped, osage/cloth/expression/motion/constraint blocks are merged, and unused vertices are removed. |
| **Export** | FBX (binary 7.4: skin, blend shapes, embedded textures, skeletal and blend-shape animation, cm or m), VRM 1.0, VRM 0.x, GLB, glTF, `.vroidpose`, `.vroidcustomitem`, and `.farc` + `ext_skp` + `mod_obj_db`. |

## Limits worth knowing

* **VRoid Studio itself** only imports `.vroidpose` and `.vroidcustomitem`. It cannot import arbitrary meshes as clothing.
  * VRoid's custom-item payload is an undocumented protobuf. This app only does safe, schema-agnostic edits: category within a family, name, IDs, and embedded images.
  * "Model → custom item" therefore works through a template item of the wanted category (export any item of that kind from VRoid Studio) plus a texture baked from your model.
* **`.vroidpose`:** VRoid has not published this format. The exporter writes the Unity-humanoid `BoneDefinition` layout that VRoid uses (left-handed, X mirrored), and the importer preserves unknown keys. Please report any pose VRoid Studio rejects.
* **Tower Unite:** the built-in profile uses UE4 mannequin bone names. For a guaranteed match, load the official Tower Unite skeleton file with **Rig convert → Convert to a provided rig file**.
* **Project DIVA:**
  * Supports the classic object-set format used by Mega Mix+, Future Tone and DT (`_obj.bin`). The modern F2nd/X format is not supported.
  * Textures are copied unchanged.
  * Objects still need to be registered in your mod's databases (`mod_obj_db.bin` is generated; item/module tables are not).
* **Not supported:** MMD `.pmx/.pmd/.vmd` (three.js dropped its MMD loader). Convert those to FBX/glTF first.
* **Spring bones:** VRM spring-bone settings are not carried through conversion. The hair and skirt bones themselves are kept.

## Development

```
npm ci
npm test          # unit tests (node:test): formats, rigging, retargeting, fitting, IK, lip sync, FBX round trip, DIVA merge…
npm start         # build the renderer and launch Electron
npm run smoke     # headless-Chromium UI smoke test (needs Playwright; set PLAYWRIGHT_PATH if it is installed globally)
```

Code layout:

* `src/core/`: skeleton definition, bone detection, rig conversion and retargeting, auto-rig, fitting, head/eye editing, IK, optimize, shape keys, lip sync, rig profiles, texture baking.
* `src/formats/`: loaders, FBX writer, glTF/VRM writer, `.vroidpose`, `.vroidcustomitem`.
* `src/diva/`: FARC (with AES), object set, texture set, skin parameter, merge and preview.
* `src/viewer/` and `src/ui/`: the 3D preview and the app UI.
* `electron/`: the main and preload processes.

See `THIRD_PARTY_NOTICES.md` for the projects whose file-format documentation this builds on.
