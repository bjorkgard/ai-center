import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { clearSceneLines, lastSceneLines } from "./sceneLog.ts";
import { reportShaderError, resetShaderErrors, shaderErrorCount } from "./shaderErrors.ts";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetShaderErrors();
  clearSceneLines();
});
afterEach(() => vi.restoreAllMocks());

// A WebGL context stub: the compile log and source of the failing fragment shader.
const gl = (log: string, source: string) =>
  ({
    getShaderInfoLog: () => log,
    getShaderSource: () => source,
    getProgramInfoLog: () => "",
  }) as never;

test("a compile failure logs one [scene] line naming the shader and counts as a frame error", () => {
  const context = gl(
    "ERROR: 0:12: 'x' : undeclared identifier\n",
    "#define SHADER_NAME MeshStandardMaterial\n",
  );
  reportShaderError(context, {} as never, {} as never, {} as never);
  expect(shaderErrorCount()).toBe(1);
  const lines = lastSceneLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[scene\] shader compile failed/);
  expect(lines[0]).toContain("MeshStandardMaterial");
  expect(lines[0]).toContain("undeclared identifier");
});

test("each failure counts, and a reset zeroes the count", () => {
  const context = gl("bad", "");
  reportShaderError(context, {} as never, {} as never, {} as never);
  reportShaderError(context, {} as never, {} as never, {} as never);
  expect(shaderErrorCount()).toBe(2);
  resetShaderErrors();
  expect(shaderErrorCount()).toBe(0);
});

test("a patched program is named by its material, not three's generic shader name", () => {
  const source = "#define SHADER_NAME MeshStandardMaterial\n// material: sign\n";
  reportShaderError(gl("bad", source), {} as never, {} as never, {} as never);
  expect(lastSceneLines()[0]).toContain("(sign)");
});

test("a material name with spaces is read to the end of its comment line", () => {
  const source = "#define SHADER_NAME MeshStandardMaterial\n// material: Sign panel\nvoid main(){}";
  reportShaderError(gl("bad", source), {} as never, {} as never, {} as never);
  expect(lastSceneLines()[0]).toContain("(Sign panel)");
});
