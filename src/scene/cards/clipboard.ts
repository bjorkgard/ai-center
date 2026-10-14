// True when the text reached the clipboard; false when it is missing or refuses (blocked, no focus).
export async function copyText(
  text: string,
  clipboard: { writeText(text: string): Promise<void> } | undefined,
): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
