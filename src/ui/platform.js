// File access: Electron (native dialogs through the preload bridge) or a plain browser fallback.
const api = globalThis.vsc ?? null;

export const isElectron = !!api;

/**
 * @param {{title?: string, filters?: {name: string, extensions: string[]}[], multiple?: boolean}} opts
 * @returns {Promise<{name: string, path?: string, bytes: Uint8Array, siblings?: Map<string, Uint8Array>}[]>}
 */
export async function openFiles(opts = {}) {
  if (api) return api.openFiles(opts);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? false;
    const exts = (opts.filters ?? []).flatMap((f) => f.extensions).filter((e) => e !== '*');
    if (exts.length) input.accept = exts.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const files = [...input.files];
      const out = [];
      for (const f of files) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      resolve(out);
    };
    input.click();
  });
}

/** Save bytes; returns the chosen path (Electron) or the download name. */
export async function saveFile(defaultName, bytes, filters = []) {
  if (api) return api.saveFile({ defaultName, bytes, filters });
  const blob = new Blob([bytes]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return defaultName;
}

/** Read sibling files in the same folder (textures referenced by FBX/OBJ/glTF). Electron only. */
export async function readSiblings(path) {
  if (!api || !path) return null;
  return api.readSiblings(path);
}

/** Save a main file plus extra files written next to it (e.g. a .dae and its textures). */
export async function saveFiles(defaultName, bytes, filters = [], extraFiles = []) {
  if (api) return api.saveFile({ defaultName, bytes, filters, extraFiles });
  const saved = await saveFile(defaultName, bytes, filters);
  for (const f of extraFiles) await saveFile(f.name, f.bytes);
  return saved;
}
