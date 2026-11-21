// Names a viewer may not use. The owner extends this list by hand.
//
// How matching works (src/server/rules.ts): a name is lowercased, the digit swaps
// 0->o, 1->i, 3->e, 4->a, 5->s are undone, spaces, "-" and "_" are removed, and the name
// is refused if the result CONTAINS any entry below. So:
// - write entries lowercase, with letters only (no digits, no spaces);
// - avoid short entries that sit inside ordinary words ("ass" would block "Cassie",
//   "class" and "bass"), and prefer the longer form ("asshole"). That is why "spic",
//   "cock" and "rape" are left out: they block "spicy", "peacock" and "grape".
//
// This file has no imports: it is bundled into the browser as well as the server.
export const BLOCKED_WORDS: readonly string[] = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "pussy",
  "whore",
  "slut",
  "wank",
  "twat",
  "nigger",
  "nigga",
  "faggot",
  "fagot",
  "retard",
  "spastic",
  "chink",
  "gook",
  "kike",
  "wetback",
  "tranny",
  "dyke",
  "hitler",
  "porn",
  "penis",
  "vagina",
];
