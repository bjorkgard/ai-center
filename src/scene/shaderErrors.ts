import { logScene } from "./sceneLog.ts";

let count = 0;

// Shader compile failures since load; the HUD's frame-error row adds them to the driver's
// count (CEO W-RW30).
export function shaderErrorCount(): number {
  return count;
}

export function resetShaderErrors(): void {
  count = 0;
}

// three's `renderer.debug.onShaderError` (WebGLRenderer.js:169-195): one [scene] line and a
// count per failed program. three does not say which material failed, so the line names the
// shader (the SHADER_NAME three defines in every program) and the first line of the compile log.
export function reportShaderError(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
): void {
  count++;
  const fragment = gl.getShaderInfoLog(fragmentShader)?.trim() ?? "";
  const vertex = gl.getShaderInfoLog(vertexShader)?.trim() ?? "";
  const log = fragment || vertex || gl.getProgramInfoLog(program)?.trim() || "no log";
  const source = gl.getShaderSource(fragmentShader) ?? "";
  // The fade patch embeds the material's name; other programs only carry three's shader name.
  const name =
    /\/\/ material: (.+)/.exec(source)?.[1]?.trim() ??
    /#define SHADER_NAME (\S+)/.exec(source)?.[1] ??
    "unknown shader";
  logScene(`shader compile failed (${name}): ${log.split("\n")[0]}`);
}
