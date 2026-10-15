// Counts renders of the Data section body, read through `__dataDev.renders()` (CEO C39).
let renders = 0;

export function countPanelRender(): void {
  renders++;
}

export function panelRenders(): number {
  return renders;
}
