import { useStore } from "../../app/store/index.ts";
import { SceneErrorCard } from "./SceneErrorCard.tsx";
import { WebglLostCard, WebglStartCard } from "./WebglCard.tsx";
import { selectCard } from "./select.ts";

// One card at a time, centred in the safe area (DR3, DR5). The parent box is the safe area.
export function CardLayer() {
  const webgl = useStore((s) => s.webgl);
  const reason = useStore((s) => s.webglReason);
  const sceneError = useStore((s) => s.sceneError);
  const card = selectCard(webgl, reason, sceneError);
  if (!card) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      {card === "webgl-start" && <WebglStartCard />}
      {card === "webgl-lost" && <WebglLostCard />}
      {card === "scene-error" && sceneError && <SceneErrorCard message={sceneError.message} />}
    </div>
  );
}
