/** Thin emoji sticker catalog — shared by app + admin. */
export const SEED_PACKS = [
  {
    id: "pack-faces",
    name: "Faces",
    publisher: "Aivora",
    featured: true,
    stickers: [
      { id: "s-grin", emoji: "😀", label: "Grin" },
      { id: "s-joy", emoji: "😂", label: "Joy" },
      { id: "s-heart-eyes", emoji: "😍", label: "Heart eyes" },
      { id: "s-cool", emoji: "😎", label: "Cool" },
      { id: "s-think", emoji: "🤔", label: "Think" },
      { id: "s-cry", emoji: "😢", label: "Cry" },
      { id: "s-fire", emoji: "🔥", label: "Fire" },
      { id: "s-ok", emoji: "👌", label: "OK" },
    ],
  },
  {
    id: "pack-gestures",
    name: "Gestures",
    publisher: "Aivora",
    featured: false,
    stickers: [
      { id: "s-wave", emoji: "👋", label: "Wave" },
      { id: "s-clap", emoji: "👏", label: "Clap" },
      { id: "s-thumbs", emoji: "👍", label: "Thumbs up" },
      { id: "s-pray", emoji: "🙏", label: "Pray" },
      { id: "s-muscle", emoji: "💪", label: "Strong" },
      { id: "s-party", emoji: "🎉", label: "Party" },
      { id: "s-heart", emoji: "❤️", label: "Heart" },
      { id: "s-100", emoji: "💯", label: "100" },
    ],
  },
] as const;

export function findSticker(stickerId: string) {
  for (const pack of SEED_PACKS) {
    const s = pack.stickers.find((x) => x.id === stickerId);
    if (s) return { pack, sticker: s };
  }
  return null;
}

export function packsToDto() {
  return SEED_PACKS.map((p) => ({
    id: p.id,
    name: p.name,
    publisher: p.publisher,
    featured: p.featured,
    stickers: p.stickers.map((s) => ({
      id: s.id,
      emoji: s.emoji,
      label: s.label,
      animated: false,
      url: null as string | null,
    })),
  }));
}
