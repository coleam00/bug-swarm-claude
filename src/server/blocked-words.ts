// Names a viewer may not use, and names kept for the people running the stream. The owner
// extends these lists by hand. Written by hand for this game, not copied from a published list.
//
// How a name is matched (src/server/rules.ts, listedReason):
// - Split into words on space, "-" and "_". Every list but RESERVED_NAMES is matched inside one
//   word at a time, never across the space between two: "Anna Ziegler" holds "nazi" and "Matt
//   Watson" holds "twat" only once the space is gone. A run of one- and two-letter words is a
//   word spelled out, so it is joined back first: "F-U_C K", "n a z i" and "fu ck" are one word.
//   Such a short word is also read glued to the word before it, the word after it and both, so
//   an uneven split ("f uck", "ni gger", "who re", "shi t") is one word too. A split into two
//   pieces of three letters or more passes ("ret ard"), unless one piece is blocked on its own
//   ("nig ger" is refused for "nig"); the owner hides those with `bun run hide`. The same goes
//   for a blocked word glued to the letters of an exception kept for a common name (below).
// - Each word normalised: lowercased, the digit swaps 0->o, 1->i, 3->e, 4->a, 5->s, 7->t, 8->b
//   undone. "5h17" is "shit".
// - Repeated letters: each run of a letter in an entry matches that many OR MORE of it in the
//   name, so "fuck" catches "fuuuck" and "pussy" catches "pussssy". The name itself is never
//   collapsed, which is what keeps "boob" from blocking "Bob" and "coon" from blocking "Connor".
//   So a doubled letter in an entry means "at least two": write the shortest spelling you want
//   caught ("fagot" catches "faggot" too; "faggot" would let "fagot" through). The same rule
//   runs into real names with a doubled letter: "polack" matches "Pollack", "boner" "Bonner".
//   Common ones are EXCEPTIONS below; rare ones ("Midgett", "Spickett") are left refused; a
//   short whole-word entry that stretches into a common name ("cok" into "Cook") is left out.
//
// Why there are three lists (the Scunthorpe problem): plain "does the name contain it" blocks
// real names. "cunt" sits inside "Scunthorpe", "ass" inside "Cassie" and "Classic", "rape" inside
// "Grape", "sex" inside "Essex". So:
// - BLOCKED_ANYWHERE: refused wherever it appears inside a word of the name. Words that are rarely
//   part of an ordinary word, whatever their length ("fuck", and slurs such as "fag", "coon" and
//   "nazi", with the real words they sit in listed in EXCEPTIONS), and compounds of the
//   whole-word entries that turn up glued ("dumbnig", "killjew").
// - BLOCKED_WHOLE: refused only when it is the whole name, or one whole word of it, with an
//   optional plural "s". Words split on space, "-" and "_", and where a capital starts a word
//   ("BigDick", "ImASpic"). For words that sit inside ordinary ones: "ass" refuses
//   "ass", "Big Ass", "BigAss" and "a s s", but not "Cassie" or "Bass". The cost is that a
//   lowercase compound ("bigdick") passes; add it to BLOCKED_ANYWHERE if it shows up.
// - EXCEPTIONS: real words cut out of each word before BLOCKED_ANYWHERE is checked
//   ("therapist" would otherwise be refused for "rapist", "Sushi Time" for "shit"). An exception
//   is replaced by a separator, not deleted, so it can't be used to join two halves of a word.
//   Keep exceptions specific: an exception is cut out wherever it appears, so it hides any
//   blocked word it holds, or shares letters with, whatever letters stand around it. A rare
//   name that is a blocked word plus a few letters ("Fagner", "Slutsky", "Kuntz", "Pakize") is
//   therefore not an exception: it stays refused, and so do "FagNerd", "SlutSky", "KuntZone"
//   and "PakiZombie". Where the name or word is common, the exception stays and the leak is
//   accepted, for the owner to hide live with `bun run hide`.
//   Accepted exception leaks. The lists test in src/server/rules.test.ts derives this list from
//   EXCEPTIONS and fails if an exception it finds is not named here:
//   - a blocked word at the start or end of the exception, which passes before or after the
//     exception's other letters:
//     - "shit": pushit, mishit, shiitake, shitake, harshit, akshit, shitij, ashit, joshit
//       ("YouAShit", "HarShit", "ShitIjust", "PuShit");
//     - "rapist": therapist ("TheRapist"); "penis": peniston ("PenisTongue");
//     - "pussy": pussycat, pussywillow, pussyfoot ("PussyCat"); "milf": milford ("MilfOrder");
//     - "twat": twater, twatch ("TwatEric", "TwatChamp"); "wank": swank, wankhede
//       ("ThisWanker", "WankHeder");
//     - "dyke": vandyke ("IvanDyke"); "boob": booboo ("BoobOoh"); "phuk": phuket ("PhukEt");
//     - "paki": pakistan ("PakiStank"); "nazi": nazir, nazim, antinazi ("NaziRule",
//       "NaziMaster");
//     - "coon": raccoon, racoon, cocoon, tycoon, cooney, coonhound ("CoonEy", "TyCoon");
//     - "fag": fagan, fagen ("FagAndy", "FagEnd"); "hardon": chardon ("CHardOn");
//     - "boner" and "polack": bonner and pollack are those words' own doubled spellings;
//   - three or more letters shared with a blocked word that starts or ends outside the
//     exception: sushi ("SuShit"), pushit, mishit, harshit, akshit, ashit and joshit
//     ("PusHitler"), booboo ("JigaBooboo"), fagan ("FaGangbang"), pussyfoot
//     ("PussyFootjob"), carbon ("CarBoner", "CarBondage"), ishita ("FetIshita");
//   - a blocked word inside, with the exception's own letters on both sides: scunthorpe,
//     ignazio, takeshita, oshita, ishita, toshitsugu ("IShitAgain", "NoShitAsshole").
//   Two shared letters are not listed: there are dozens ("TwatChink" hides "chink" behind
//   "twatch") and the names they make are contrived.
//   No exception may contain another: where the longer one appears the shorter one does too
//   and already lets the name through, so the longer one only adds places for a word to hide.
// Numbers: a name that starts or ends with a number (one digit or more) is also read without it
// (an age, a year, a "2"), and refused if either reading is: "ass2", "2fag", "1 Admin" and
// "Cole Medin 2" are refused, and "pen15" and "5hit" still read "penis" and "shit". A word made
// only of digits inside a longer name ("load-4455") is a number, never letters. "Ash17" and
// "Josh17" read "ashit" and "joshit", which EXCEPTIONS lets through.
// Known false positives, accepted: "Wankel", "Snigger", "Dykes", "Retardant" and "Lesbos" are
// refused, and so are other names ending "sh" + 17 ("Fish17", "Rush17"), Thai names built on
// "porn" (Pornthep), "Nazia", "Gnazio", "McCoon", "Coonie" and "Kunti", the surnames "Coons",
// "Fagg", "Fago" and "Faggi" (an exception for them would let "coons", "faggot", "fagot" and
// "faggit" through), "Japp" (exceptions are not applied to BLOCKED_WHOLE), "Twatt", "Wanke",
// "Cunto", "Cuntz" and "Pecker", the rare names "Chinkin", "Gookin", "Kikel", "Kyker",
// "Fagin", "Faggin", "Kunta", "Cooner" and "Nazionale", and the rarer names dropped from
// EXCEPTIONS for the same reason (see "Keep exceptions specific"): "Darshit", "Pakize",
// "Coonan", "Coonawarra", "Coontz", "Coonts", "Coonrod", "Coonley", "Coonradt", "Kuntz",
// "Kuntal", "Fager", "Fagel", "Faggio", "Fagioli", "Fagundes", "Fagnani", "Fagner",
// "Faggiano", "Spazio", "Spaziani", "Spazzoli", "Shittu", "Shitara", "Bonerjee", "Midgett",
// "Spickett", "Spickard", "Spickler", "Spickermann", "Slutsky", "Slutzky", "Wankowski",
// "Pennison" and "Yoshito"; a whole word such as "Moby Dick" or "DeHoe", and two names glued into one word ("AnnaZiegler"): only spaces,
// "-" and "_" separate words for BLOCKED_ANYWHERE, because splitting at capitals would let
// "CunTface" through. Gluing short words to their neighbours also refuses some initials and
// two-letter names beside a word: "F Aguilar" and "Rafa G" (fag), "T Watson" (twat), "Anna L"
// and "Anna Al" (anal), "Ji Smith" (jism), "Andy Ke" (dyke).
//
// RESERVED_NAMES: refused for players, who see the start screen's "Pick a different name"
// (src/web/start.ts). Three groups: the factory (colemedin, dynamous, archon), the host and the
// people running the stream (cole, host, streamer, mod, moderator, admin, official) and the
// platforms it streams on (youtube, twitch), so nobody poses as them on a public stream (#106).
// Matched against the whole normalised name with the same repeated-letter rule ("Cole Medin",
// "c0le_medin", "You Tube", "Host 2" and "Addmin" are refused, and so are "Mood" and "Coole");
// a name that only contains one ("Archonaut", "Nicole", "Coleman", "Hosta", "Moderna") is fine.
// Names that read as a bot are kept for the server's bots by rules.ts isBotName, not here, so
// fill bots keep their names on the boards.
//
// The boards (top 10 and team totals) hide a stored name these lists now refuse, at read time.
//
// To add a word: one entry per line, lowercase a to z only. Then run `bun run check`: the
// allowlist test in src/server/rules.test.ts fails if the entry blocks a real name. If it does,
// move the entry to BLOCKED_WHOLE, or add the real word to EXCEPTIONS.
//
// This file has no imports: it is bundled into the browser as well as the server.

export const BLOCKED_ANYWHERE: readonly string[] = [
  // Profanity
  "fuck",
  "fvck",
  "fcuk",
  "phuck",
  "phuk",
  "fucc",
  "fukyou",
  "fukoff",
  "fukin",
  "fuker",
  "fukwit",
  "fukwad",
  "fckyou",
  "fckoff",
  "fckin",
  "fcker",
  "fukface",
  "mothafuk",
  "muthafuk",
  "mthrfck",
  "shit",
  "shyt",
  "sheeit",
  "bitch",
  "biatch",
  "biotch",
  "bytch",
  "beyotch",
  "ashole",
  "azzhole",
  "arsehole",
  "asshat",
  "asswipe",
  "assclown",
  "assface",
  "asslick",
  "assmunch",
  "asskiss",
  "assbag",
  "jackass",
  "dumbass",
  "dumass",
  "fatass",
  "lardass",
  "smartass",
  "kissmyass",
  "bigass",
  "arsewipe",
  "bastard",
  "cunt",
  "cvnt",
  "kunt",
  "dickhead",
  "dickface",
  "dickwad",
  "dickweed",
  "dickhole",
  "dicksuck",
  "dikhead",
  "cocksuck",
  "cockhead",
  "cockface",
  "cockring",
  "twat",
  "wank",
  "tosser",
  "bellend",
  "knobhead",
  "knobend",
  "bollock",
  "pisshead",
  "pissoff",
  "pissflap",
  "douche",
  "jerkoff",
  "jackoff",
  "skank",
  "slut",
  "whore",
  "hoebag",
  "pusy",
  "pussie",
  "scumbag",
  "turdface",
  "craphead",
  "numbnut",
  "goddamn",
  "bullcrap",
  // Sexual terms
  "porn",
  "penis",
  "vagina",
  "clitoris",
  "dildo",
  "blowjob",
  "handjob",
  "rimjob",
  "footjob",
  "titjob",
  "cumshot",
  "cumdump",
  "cumbucket",
  "cumstain",
  "cumsock",
  "cumguzzl",
  "cumface",
  "jizz",
  "jism",
  "jizm",
  "sperm",
  "boner",
  "orgasm",
  "milf",
  "boob",
  "titty",
  "tittie",
  "nipple",
  "butthole",
  "buttplug",
  "buttsex",
  "analsex",
  "scrotum",
  "testicle",
  "ballsack",
  "nutsack",
  "schlong",
  "hentai",
  "sexy",
  "sexslave",
  "sextoy",
  "rapist",
  "molest",
  "pedophil",
  "paedo",
  "pedobear",
  "incest",
  "bestiality",
  "zoophil",
  "necrophil",
  "creampie",
  "deepthroat",
  "gangbang",
  "bukkake",
  "felch",
  "fellatio",
  "cunnilingus",
  "smegma",
  "queef",
  "cameltoe",
  "masturbat",
  "jackingoff",
  "strapon",
  "fleshlight",
  "onlyfans",
  "xvideos",
  "xhamster",
  "camgirl",
  "dickpic",
  "nudes",
  "horndog",
  "hornyteen",
  "sexting",
  "sixtynine",
  "bdsm",
  "bondage",
  "fetish",
  "upskirt",
  "voyeur",
  "erotic",
  "stripclub",
  "brothel",
  "prostitut",
  "dominatrix",
  "suckmy",
  "lickmy",
  "spankme",
  "fingerbang",
  "pegging",
  "ejaculat",
  "jerkmeoff",
  "wetdream",
  "pubes",
  "pubichair",
  "foreskin",
  "labia",
  "vulva",
  "areola",
  "erection",
  "hardon",
  // Racial and ethnic slurs
  "nigger",
  "nigga",
  "nigguh",
  "niggur",
  "niglet",
  "nignog",
  "niggr",
  "niqq",
  "dumbnig",
  "hatenig",
  "killnig",
  "coon",
  "paki",
  "dumbspic",
  "spicboy",
  "negroid",
  "jigaboo",
  "porchmonkey",
  "junglebunn",
  "darkie",
  "golliwog",
  "spick",
  "beaner",
  "wetback",
  "chink",
  "gook",
  "zipperhead",
  "slanteye",
  "kike",
  "kyke",
  "raghead",
  "towelhead",
  "cameljockey",
  "sandmonkey",
  "redskin",
  "kafir",
  "polack",
  "chinaman",
  "halfbreed",
  "spearchucker",
  "tarbab",
  "pickanin",
  "mudshark",
  "gasthejew",
  "killthejew",
  "jewboy",
  "hitler",
  "nazi",
  "kkk",
  "killjew",
  "hatejew",
  "killblack",
  "hateblack",
  "killmuslim",
  "hatemuslim",
  "killarab",
  "killasian",
  "killmexican",
  "siegheil",
  "whitepower",
  "whitepride",
  "kukluxklan",
  "swastika",
  "aryannation",
  "thirdreich",
  "holohoax",
  // Homophobic and transphobic slurs
  "fag",
  "dyke",
  "killgay",
  "hategay",
  "killtrans",
  "hatetrans",
  "lesbo",
  "lezbo",
  "lezzie",
  "trann",
  "shemale",
  "poofter",
  "sodomite",
  "battyboy",
  "battyman",
  "fudgepacker",
  "buttpirate",
  "carpetmuncher",
  "pillowbiter",
  "nohomo",
  // Ableist slurs
  "retard",
  "libtard",
  "spastic",
  "spaz",
  "dumbtard",
  "spacker",
  "spakka",
  "mongoloid",
  "cripple",
  "midget",
  "windowlicker",
  // Abuse aimed at a person
  "killyourself",
  "killurself",
  "neckyourself",
  "hangyourself",
  "gokys",
  "suicidebomb",
  "schoolshoot",
  "rapeyou",
  "iwillrape",
];

export const BLOCKED_WHOLE: readonly string[] = [
  "ass",
  "arse",
  "azz",
  "fuk",
  "fuq",
  "fck",
  "fux",
  "stfu",
  "gtfo",
  "wtf",
  "kys",
  "sht",
  "btch",
  "dick",
  "dik",
  "cock",
  "prick",
  "twot",
  "piss",
  "turd",
  "crap",
  "mofo",
  "hoe",
  "thot",
  "slag",
  "bj",
  "cum",
  "jiz",
  "semen",
  "tit",
  "anal",
  "clit",
  "anus",
  "pecker",
  "knob",
  "fap",
  "sex",
  "nude",
  "horny",
  "orgy",
  "orgie",
  "rape",
  "raped",
  "raping",
  "pedo",
  "pron",
  "vag",
  "spunk",
  "nig",
  "niga",
  "nigr",
  "ngga",
  "nibba",
  "negro",
  "darky",
  "wog",
  "spic",
  "spik",
  "jap",
  "heeb",
  "yid",
  "injun",
  "squaw",
  "dago",
  "wop",
  "gypo",
  "heil",
  "fgt",
  "homo",
  "poof",
  "tard",
  "downie",
];

export const EXCEPTIONS: readonly string[] = [
  "scunthorpe",
  "therapist",
  "sushi",
  "pushit",
  "mishit",
  "shiitake",
  "shitake",
  "peniston",
  "pussycat",
  "pussywillow",
  "twater",
  "twatch",
  "swank",
  "vandyke",
  "booboo",
  "phuket",
  "harshit",
  "akshit",
  "pakistan",
  "nazir",
  "nazim",
  "raccoon",
  "racoon",
  "cocoon",
  "tycoon",
  "fagan",
  "fagen",
  "ignazio",
  "antinazi",
  "cooney",
  "coonhound",
  "shitij",
  "ashit",
  "joshit",
  "wankhede",
  "pussyfoot",
  "carbon",
  "milford",
  "bonner",
  "pollack",
  "chardon",
  "takeshita",
  "oshita",
  "ishita",
  "toshitsugu",
];

export const RESERVED_NAMES: readonly string[] = [
  // The factory.
  "colemedin",
  "dynamous",
  "archon",
  // The host and the people running the stream.
  "cole",
  "host",
  "streamer",
  "mod",
  "moderator",
  "admin",
  "official",
  // The platforms.
  "youtube",
  "twitch",
];
