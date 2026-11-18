export const chatGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function foldChatText(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

export function findChatTextSpan(text: string, query: string): { start: number; end: number } | undefined {
  const needle = foldChatText(query);
  if (!needle) return;
  const matchStart = foldChatText(text).indexOf(needle);
  if (matchStart < 0) return;
  const matchEnd = matchStart + needle.length;
  let foldedEnd = 0;
  let start: number | undefined;
  for (const { index, segment } of chatGraphemeSegmenter.segment(text)) {
    foldedEnd += foldChatText(segment).length;
    if (foldedEnd > matchStart) start ??= index;
    if (foldedEnd >= matchEnd) return { start: start ?? index, end: index + segment.length };
  }
}
