import { describe, expect, test } from "bun:test";
import { BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_NAMES } from "./blocked-words";
import {
  MAX_UPGRADES,
  TEAMS,
  UPGRADE_IDS,
  UPGRADE_MAX_LEVEL,
  checkName,
  checkScore,
  entryPattern,
  isShownName,
  isTeam,
  isUpgradeId,
  nameKey,
  normalizeName,
} from "./rules";

describe("name rules", () => {
  test("a valid name passes and comes back normalized", () => {
    expect(checkName("Robo_Fan-42")).toEqual({ ok: true, name: "Robo_Fan-42" });
    expect(checkName("  big   bug  ")).toEqual({ ok: true, name: "big bug" });
    expect(normalizeName("  a  b   c ")).toBe("a b c");
    expect(nameKey(" Big  Bug ")).toBe("big bug");
  });

  test("2 to 16 characters, measured after trimming", () => {
    expect(checkName("a")).toEqual({ ok: false, reason: "length" });
    expect(checkName("   a   ")).toEqual({ ok: false, reason: "length" });
    expect(checkName("ab").ok).toBe(true);
    expect(checkName("abcdefghijklmnop").ok).toBe(true);
    expect(checkName("abcdefghijklmnopq")).toEqual({ ok: false, reason: "length" });
    expect(checkName("")).toEqual({ ok: false, reason: "length" });
  });

  test("only ASCII letters, numbers, spaces, - and _", () => {
    expect(checkName("bob!")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("<b>hi</b>")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("José")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("a\tb")).toEqual({ ok: false, reason: "characters" });
  });

  test("blocked words are refused whatever the case, swaps or separators", () => {
    const refused = { ok: false, reason: "blocked" } as const;
    expect(checkName("shit")).toEqual(refused);
    expect(checkName("ShIt happens")).toEqual(refused);
    expect(checkName("sh1t")).toEqual(refused); // 1 -> i
    expect(checkName("b0ll0cks fuck")).toEqual(refused);
    expect(checkName("f0ck")).toEqual({ ok: true, name: "f0ck" }); // o, not u: not on the list
    expect(checkName("wh0re")).toEqual(refused); // 0 -> o
    expect(checkName("r3tard")).toEqual(refused); // 3 -> e
    expect(checkName("b4stard")).toEqual(refused); // 4 -> a
    expect(checkName("a55hole")).toEqual(refused); // 5 -> s
    expect(checkName("s h-i_t")).toEqual(refused);
    expect(checkName("xxFUCKxx")).toEqual(refused);
  });

  test("ordinary names that contain short words still pass", () => {
    expect(checkName("Cassie").ok).toBe(true);
    expect(checkName("peacock").ok).toBe(true);
    expect(checkName("grape").ok).toBe(true);
  });

  const refused = { ok: false, reason: "blocked" } as const;
  const refuses = (names: string[]) => expect(names.filter((n) => checkName(n).ok)).toEqual([]);

  test("separators, case, repeated letters and every digit swap (7 for t, 8 for b too) are ignored", () => {
    refuses(["f u c k", "F-U_C-K", "FUCK", "fuuuck", "fuuuuuck", "fuckkk", "assshole", "pussssy", "niiigga"]);
    refuses(["bi7ch", "5h17", "sh17", "8oner", "n1gg3r", "f4gg0t", "sh1t", "r4pe", "c0ck"]);
  });

  test("short words are refused as a whole name or a whole word of it, plural too", () => {
    refuses(["ass", "a s s", "Big Ass", "big_ass", "dick", "Dicks", "c0ck", "Spic", "fag", "kkk", "Cum Lord"]);
    // A capital after a small letter starts a word.
    refuses(["BigDick", "TheCock", "ImASpic", "HeilBoy", "SpicLover"]);
  });

  test("slurs glued to other words, and their common respellings, are refused", () => {
    refuses(["fatfag", "FatFag", "dumbfag", "ImAFag", "uRaFag", "dumbnig", "ihatenigs", "dumbcoon", "dumbspic"]);
    refuses(["KillPakis", "pakiboy", "nazi4life", "XxFagxX", "KKKlover", "dumbtard", "spazboy"]);
    refuses(["killjews", "ihatejews", "killgays", "ihategays"]);
    refuses(["niqqa", "niqqer", "ngga", "niggr", "nigr", "nibba"]);
  });

  test("one sample from each kind: racial, homophobic, ableist, sexual", () => {
    refuses(["chink", "wetback", "kike"]); // racial
    refuses(["dyke", "tranny", "fagot"]); // homophobic and transphobic
    // Plurals of entries that end in y.
    refuses(["trannies", "trannie", "kunties", "junglebunnies", "tarbabies", "pickaninnies", "orgies"]);
    refuses(["retard", "spastic", "mongoloid"]); // ableist
    refuses(["blowjob", "dildo", "cumshot"]); // sexual
  });

  test("a blocked word is looked for inside each word, and across a space only beside a short piece", () => {
    const names = ["Anna Ziegler", "Tina Ziegler", "Dana Zito", "Rafa Garcia", "Rafa Gonzalez", "Mustafa Gul"];
    names.push("Pippa King", "Philippa King", "Marco Onofrio", "Rocco Ong", "Mona Zinn", "Gerry Cooney", "Kevin Cooney");
    names.push("Matt Watson", "Trish Ito", "Nick Ike", "Shi Taylor", "Cass Kiss");
    expect(names.filter((n) => !checkName(n).ok)).toEqual([]);
    // A word spelled out in one- and two-letter pieces is still one word.
    refuses(["F a g", "n a z i", "k k k", "fu ck", "Big F a g", "sh it head", "N-I-G-G-A"]);
    // A short piece is read glued to the word beside it, so an uneven split is one word too.
    refuses(["f uck", "c unt", "ni gger", "f aggot", "s hit", "n azi", "p orn", "a sshole", "who re", "shi t"]);
    refuses(["kik e", "dyk e", "spi c", "coo n", "Big f uck", "f uck you", "my ni gger", "F-uck", "c_unt"]);
    // Glued to the word before and after at once: neither one-sided join is a blocked word.
    refuses(["bit c hes"]);
  });

  test("an exception doesn't hide a blocked word beside it, and cutting it out joins nothing", () => {
    refuses(["Scunthorpefuck", "Therapist rapist", "Sushi shit"]);
    expect(checkName("fuscunthorpeck").ok).toBe(true); // "fu|ck", not "fuck"
  });

  test("a number at the end of a longer name is a number, not letters", () => {
    for (const n of ["Josh17", "Ash17", "Cash17", "Tim17", "Alex88", "Bot 4455", "Team-7117"]) expect(checkName(n).ok).toBe(true);
    refuses(["5h17", "sh17", "fuck17", "ass99", "Big Ass99", "Big Ass 99"]);
    // One digit is a number too.
    refuses(["ass2", "dick9", "cum1", "anal2", "cock2", "bj7", "Big Ass 2"]);
    // So is one at the front.
    refuses(["2cum", "3tit", "1ass", "2anus", "69dick", "9sex", "5hit", "8oner"]);
    for (const n of ["4ever", "1Direction", "2Cash", "7Eleven", "9Lives", "3Musketeers"]) expect(checkName(n).ok).toBe(true);
    // Digits spelling the end of a word still read as letters.
    refuses(["pen15", "p3n15", "wh0r35", "a55h0l35", "cun75", "bullsh17", "dipsh17"]);
  });

  // Decides the approach: every entry is checked against these real names and words, each of
  // which contains a blocked word. An entry that breaks one moves to BLOCKED_WHOLE, or the real
  // word goes into EXCEPTIONS (src/server/blocked-words.ts).
  const ALLOWED = [
    ...["Scunthorpe", "Cassie", "Dickens", "Dickson", "Benedick", "Hancock", "Cockburn", "Peacock", "Essex"],
    ...["Grape", "Spicy", "Classic", "Analyst", "Assistant", "Therapist", "Bass", "Glass", "Sussex"],
    ...["Cumberland", "Document", "Cucumber", "Scrape", "Drapery", "Shuttlecock", "Assassin"],
    ...["Sushi Time", "Push It", "Mishit", "Matsushita", "Shitake", "Shiitake", "Kshitij", "Harshit", "Ashit", "Akshit", "Lakshit", "Rakshit", "Darshit"],
    ...["Bob", "Connor", "Helen", "Booboo", "Shelly", "Hello"],
    ...["Titan", "Raccoon", "Cocoon", "Tycoon", "Pedro", "Homer", "Arsenal", "Butterfly", "Penelope"],
    ...["Ashley", "Sasha", "Nikita", "Cockatoo", "Hitchcock", "Phoebe", "Saltwater", "Atwater"],
    ...["Saturday", "Basement", "Amusement", "Torpedo", "Swanky", "Mustard", "Custard", "Button"],
    ...["Japan", "Pakistan", "Egypt", "Middlesex", "Canal", "Janus", "Uranus", "Enigma", "Nigel"],
    ...["Vandyke", "Wang", "Dong", "Fanny", "Willy", "Clitheroe", "Literal", "Nightwatch", "Phuket"],
    ...["Pussycat", "Penistone", "Peniston", "Milford", "Carbonara", "Wankhede", "Nazir", "Sextant"],
    ...["Mongoose", "Tardis", "Stardust", "Leotard", "Pedometer", "Speedo", "Homophone", "Spice"],
    ...["Hispanic", "Specific", "Cockpit", "Scumm", "Analog", "Titanic", "Hoedown", "Sambuca"],
    ...["Fagan", "Fagen", "Fagin", "Faggin", "Fagioli", "Fagundes", "Fagerstrom", "Ignazio", "Nazionale"],
    ...["Nazim", "Benazir", "Antinazi", "Pakize", "Coonan", "Coonawarra", "Coontz", "Cooney", "Coonts"],
    ...["Coonrod", "Coonley", "Kunta", "Kuntz", "Kuntal", "Racoon", "Faggio", "Pussywillow", "Shittu"],
    ...["Pussyfoot", "Carbon"],
    // Surnames an entry runs into through a doubled letter, or sits inside.
    ...["Cook", "Cooks", "Tim Cook", "Pollack", "Bonner", "Bonerjee", "Midgett", "Spickett", "Spickard"],
    ...["Spickler", "Chardonnay", "Kyker", "Spaziani", "Faggiano", "Fagel", "Gookin", "Slutsky"],
    // Japanese and Indian names with "shit" inside.
    ...["Kinoshita", "Morishita", "Takeshita", "Oshita", "Kishita", "Ishita", "Yoshitaka", "Yoshitomi"],
    ...["Toshitsugu", "Hoshitani", "Shitara", "Nishita"],
    ...["Coonhound", "Spazio", "Tycoons", "Kakkar", "McDonald", "LaToya", "DiCaprio", "DeAndre", "LeBron"],
    ...["Ali Butt", "Sambo", "Day Spas", "Mong Kok"],
  ];

  test("real names and words that contain a blocked word pass", () => {
    expect(ALLOWED.filter((n) => !checkName(n).ok)).toEqual([]);
  });

  test("reserved names are refused as reserved, whatever the spelling; names that only contain one pass", () => {
    const reserved = { ok: false, reason: "reserved" } as const;
    for (const n of ["colemedin", "Cole Medin", "cole_medin", "c0le-medin", "Dynamous", "ARCHON", "admin", "Addmin", "moderator", "admin99", "Cole Medin 2", "admin1", "Archon2", "Moderator2", "Dynamous 1", "1 Admin", "2 Archon", "007Archon", "1Moderator", "1dynamous", "69 Cole Medin"]) {
      expect(checkName(n)).toEqual(reserved);
    }
    for (const n of ["Archonaut", "admins team", "Cole", "Medina", "Moderato", "Admiral"]) expect(checkName(n).ok).toBe(true);
  });

  test("the boards show a stored name only if the lists allow it, whatever its length", () => {
    expect(isShownName("Alice")).toBe(true);
    expect(isShownName("A")).toBe(true); // too short to pick now, but the lists don't refuse it
    expect(isShownName("fuuuck")).toBe(false);
    expect(isShownName("admin")).toBe(false);
    expect(isShownName("  Cole   Medin ")).toBe(false);
  });

  test("the lists: lowercase a to z, no duplicates, a few hundred blocked words, nothing redundant", () => {
    for (const list of [BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_NAMES]) {
      expect(list.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(BLOCKED_ANYWHERE.length + BLOCKED_WHOLE.length).toBeGreaterThanOrEqual(250);
    // No entry is already caught by another, so the count is real words, not padding.
    const anywhere = BLOCKED_ANYWHERE.map((w) => [w, new RegExp(entryPattern(w))] as const);
    const redundant = [...BLOCKED_ANYWHERE, ...BLOCKED_WHOLE].filter((w) => anywhere.some(([o, re]) => o !== w && re.test(w)));
    expect(redundant).toEqual([]);
    // No exception is itself a whole-word block or a reserved name.
    expect(EXCEPTIONS.filter((w) => w.length <= 16 && !checkName(w).ok)).toEqual([]);
  });
});

describe("score plausibility", () => {
  // At 30 s elapsed: score cap is 10 * squashes + 32, squash cap 180, seconds cap 32.
  test("accepted exactly at each bound", () => {
    expect(checkScore({ score: 232, squashes: 20, seconds: 30 }, 30)).toEqual({ ok: true });
    expect(checkScore({ score: 0, squashes: 180, seconds: 32 }, 30)).toEqual({ ok: true });
    expect(checkScore({ score: 0, squashes: 0, seconds: 0 }, 0)).toEqual({ ok: true });
  });

  test("one point over the score bound is refused", () => {
    expect(checkScore({ score: 233, squashes: 20, seconds: 30 }, 30).ok).toBe(false);
  });

  test("more than 6 squashes per elapsed second is refused", () => {
    expect(checkScore({ score: 0, squashes: 181, seconds: 30 }, 30).ok).toBe(false);
  });

  test("claiming more seconds than really passed (plus 2 s slack) is refused", () => {
    expect(checkScore({ score: 0, squashes: 0, seconds: 32.5 }, 30).ok).toBe(false);
  });

  test("negative or non-integer values are refused", () => {
    expect(checkScore({ score: -1, squashes: 0, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 1.5, squashes: 0, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 0.5, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: -1, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 1, seconds: -1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 1, seconds: Number.NaN }, 30).ok).toBe(false);
  });
});

describe("upgrades", () => {
  test("every upgrade at its top level fits in what a finished run may report", () => {
    expect(UPGRADE_IDS.length * UPGRADE_MAX_LEVEL).toBeLessThanOrEqual(MAX_UPGRADES);
  });

  test("only the listed ids are upgrades", () => {
    for (const id of UPGRADE_IDS) expect(isUpgradeId(id)).toBe(true);
    for (const v of ["", "Review-Laser", "laser", "CI-Drone", "drone", 1, null, undefined]) expect(isUpgradeId(v)).toBe(false);
  });
});

describe("teams", () => {
  test("only the listed teams are teams", () => {
    for (const t of TEAMS) expect(isTeam(t)).toBe(true);
    for (const v of ["Tabs", "SPACES", "", "tab", 1, null, undefined]) expect(isTeam(v)).toBe(false);
  });
});
