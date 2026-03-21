import fs from "node:fs";
import path from "node:path";

import { Schema } from "effect";

type StateJsonCodec<T> = Schema.Codec<T, unknown, never, never>;

export function readStateJsonFile<T>(input: {
  readonly filePath: string;
  readonly schema: StateJsonCodec<T>;
  readonly fallback: T;
}): T;
export function readStateJsonFile<T, Fallback>(input: {
  readonly filePath: string;
  readonly schema: StateJsonCodec<T>;
  readonly fallback: Fallback;
}): T | Fallback;
export function readStateJsonFile<T, Fallback>(input: {
  readonly filePath: string;
  readonly schema: StateJsonCodec<T>;
  readonly fallback: Fallback;
}): T | Fallback {
  try {
    const raw = fs.readFileSync(input.filePath, "utf8");
    return Schema.decodeSync(Schema.fromJsonString(input.schema))(raw);
  } catch {
    return input.fallback;
  }
}

export function writeStateJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}
