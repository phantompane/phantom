// scriptc 0.3 does not compile the published human-id package. Names stay
// readable and unique enough for generated worktrees.
const adjectives = [
  "amber",
  "bold",
  "bright",
  "calm",
  "clear",
  "crisp",
  "eager",
  "gentle",
  "golden",
  "happy",
  "kind",
  "lucky",
  "nimble",
  "quiet",
  "rapid",
  "silver",
  "steady",
  "swift",
  "vivid",
  "warm",
];

const nouns = [
  "badger",
  "comet",
  "falcon",
  "harbor",
  "heron",
  "island",
  "maple",
  "otter",
  "pebble",
  "quartz",
  "river",
  "sparrow",
  "summit",
  "thicket",
  "willow",
];

export function humanName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(Math.random() * 1000);
  return `${adjective}-${noun}-${suffix}`;
}
