import * as z from "zod/mini";

// The log-server wire protocol (PLAN chunk 14a), shared by the Node server and the browser
// client. Only Node-runnable imports here (CEO C30, eng E31).
export const STREAM_PATH = "/api/stream";

export const RootSource = z.enum(["flag", "env", "config", "default"]);
export type RootSource = z.infer<typeof RootSource>;

const Count = z.int().check(z.gte(0));

export const Cursor = z.object({ path: z.string(), fileId: z.string(), offset: Count });
export type Cursor = z.infer<typeof Cursor>;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  token: z.string(),
  cursors: z.array(Cursor),
});

/** The absolute line total of one file identity, never a delta: a re-read replaces the value. */
export const LinesMessage = z.object({
  type: z.literal("lines"),
  path: z.string(),
  fileId: z.string(),
  total: Count,
});

export const ProgressMessage = z.object({
  type: z.literal("progress"),
  done: Count,
  total: Count,
});

export const RootInfoMessage = z.object({
  path: z.string(),
  files: Count,
  reason: z.optional(z.string()),
  source: RootSource,
  // Set when `path` is the config file itself and it could not be used (instead of a folder).
  configError: z.optional(z.boolean()),
});
export type RootInfoMessage = z.infer<typeof RootInfoMessage>;

export const RootsMessage = z.object({ type: z.literal("roots"), roots: z.array(RootInfoMessage) });
export const HeartbeatMessage = z.object({ type: z.literal("heartbeat") });

export const ClientMessage = z.discriminatedUnion("type", [HelloMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  LinesMessage,
  ProgressMessage,
  RootsMessage,
  HeartbeatMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type LinesMessage = z.infer<typeof LinesMessage>;

function parseWith<T>(schema: z.ZodMiniType<T>, text: string): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Parses one text frame from a client; undefined when it is not valid JSON or not a known message. */
export const parseClientMessage = (text: string): ClientMessage | undefined =>
  parseWith(ClientMessage, text);

export const parseServerMessage = (text: string): ServerMessage | undefined =>
  parseWith(ServerMessage, text);
