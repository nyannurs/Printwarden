// Background thread for the heavy pdf-lib jobs: reading structure on import, writing the
// imposed PDF on export. Keeps the interface responsive with large files.

import { writeImposedPdf } from "../impose/writer.js";
import { readImposition, readStructure } from "./structure.js";

const tasks = {
  structure: ({ bytes }) => readStructure(bytes),
  imposition: ({ bytes }) => readImposition(bytes),
  export: ({ bytes, analysis, plan, info, coverBytes }) => writeImposedPdf(bytes, analysis, plan, info, coverBytes ?? null),
};

self.onmessage = async ({ data }) => {
  try {
    const result = await tasks[data.type](data);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id: data.id, result }, transfer);
  } catch (err) {
    self.postMessage({ id: data.id, error: String(err?.message ?? err) });
  }
};
