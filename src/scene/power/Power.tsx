import { useEffect, useMemo } from "react";
import { buildPower } from "./buildPower.ts";

// The power yard: substation, generators, fuel tanks and the fibre vault (chunk 10). Static: it
// reads no signals and draws as one mesh.
export function Power() {
  const built = useMemo(() => buildPower(), []);
  useEffect(() => () => built.dispose(), [built]);
  return <primitive object={built.group} dispose={null} />;
}
