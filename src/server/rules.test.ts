import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILL_BOT_NAMES } from "./arena/fill";
import { BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_EXACT, RESERVED_NAMES, RESERVED_WORDS } from "./blocked-words";
import {
  TEAMS,
  checkName,
  entryPattern,
  isBotName,
  isShownName,
  isTeam,
  nameKey,
  normalizeName,
  pickTeam,
} from "./rules";

describe("the team pick (#131)", () => {
  const none = () => {
    throw new Error("totals read without a tie");
  };
  test("the team with fewer people playing wins, without reading the totals", () => {
    expect(pickTeam({ tabs: 3, spaces: 2 }, none)).toBe("spaces");
    expect(pickTeam({ tabs: 0, spaces: 1 }, none)).toBe("tabs");
  });
  test("a tie goes to the team with the lower total, and a tie there to Tabs", () => {
    expect(pickTeam({ tabs: 2, spaces: 2 }, () => ({ tabs: 900, spaces: 100 }))).toBe("spaces");
    expect(pickTeam({ tabs: 2, spaces: 2 }, () => ({ tabs: 100, spaces: 900 }))).toBe("tabs");
    expect(pickTeam({ tabs: 0, spaces: 0 }, () => ({ tabs: 0, spaces: 0 }))).toBe("tabs");
  });
});

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
    // A rare name that is a slur plus a few letters is not an exception, so the slur is refused
    // before ordinary words. The common ones that stay (nazir, fagan, cooney...) are listed as
    // accepted leaks in blocked-words.ts, and the lists test below keeps that list complete.
    refuses(["ChinkInvader", "Chinkins", "GookInvasion", "Gooking", "KikeLover", "KykeRaider", "FagInvader", "FaggInvader"]);
    refuses(["KuntAgain", "NaziOnline", "CoonEric", "FagNerd", "FagUnder", "FagIota", "SlutSky", "KuntZone"]);
    refuses(["PakiZombie", "YoShitOnYou", "ShitAra", "ShittUp", "CoonRadio", "CoonRodeo", "CoonLey", "SpazIoli", "DarShit"]);
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
    ...["Sushi Time", "Push It", "Mishit", "Matsushita", "Shitake", "Shiitake", "Kshitij", "Harshit", "Ashit", "Akshit", "Lakshit", "Rakshit"],
    ...["Bob", "Connor", "Helen", "Booboo", "Shelly", "Hello"],
    ...["Titan", "Raccoon", "Cocoon", "Tycoon", "Pedro", "Homer", "Arsenal", "Butterfly", "Penelope"],
    ...["Ashley", "Sasha", "Nikita", "Cockatoo", "Hitchcock", "Phoebe", "Saltwater", "Atwater"],
    ...["Saturday", "Basement", "Amusement", "Torpedo", "Swanky", "Mustard", "Custard", "Button"],
    ...["Japan", "Pakistan", "Egypt", "Middlesex", "Canal", "Janus", "Uranus", "Enigma", "Nigel"],
    ...["Vandyke", "Wang", "Dong", "Fanny", "Willy", "Clitheroe", "Literal", "Nightwatch", "Phuket"],
    ...["Pussycat", "Penistone", "Peniston", "Milford", "Carbonara", "Wankhede", "Nazir", "Sextant"],
    ...["Mongoose", "Tardis", "Stardust", "Leotard", "Pedometer", "Speedo", "Homophone", "Spice"],
    ...["Hispanic", "Specific", "Cockpit", "Scumm", "Analog", "Titanic", "Hoedown", "Sambuca"],
    ...["Fagan", "Fagen", "Ignazio"],
    ...["Nazim", "Benazir", "Antinazi", "Cooney", "Racoon", "Pussywillow"],
    ...["Pussyfoot", "Carbon"],
    // Surnames an entry runs into through a doubled letter, or sits inside.
    ...["Cook", "Cooks", "Tim Cook", "Pollack", "Bonner", "Chardonnay"],
    // Japanese and Indian names with "shit" inside.
    ...["Kinoshita", "Morishita", "Takeshita", "Oshita", "Kishita", "Ishita", "Yoshitaka"],
    ...["Toshitsugu", "Hoshitani", "Nishita"],
    ...["Coonhound", "Tycoons", "Kakkar", "McDonald", "LaToya", "DiCaprio", "DeAndre", "LeBron"],
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
    // The host and the platforms (#106), in the spellings the profanity check reads through.
    for (const n of ["cole", "Cole", "C0le", "c o le", "host", "Host 2", "H0st", "streamer", "Stream_er", "mod", "M0d", "MOD", "moderator", "admin", "official", "Official", "0fficial", "youtube", "YouTube", "You Tube", "you-tube", "twitch", "Tw1tch", "TWITCH 7"]) {
      expect(checkName(n)).toEqual(reserved);
    }
    for (const n of ["Archonaut", "admins team", "Medina", "Moderato", "Admiral", "Nicole", "Coleman", "Cole Porter", "Hosta", "Hostess", "Ghost", "Moderna", "Mode", "Twitcher", "YouTuber", "Streamers Fan", "Robot", "Abbot"]) {
      expect(checkName(n).ok).toBe(true);
    }
    // The host and platform words take no repeated-letter rule, so real names that reach one only that way pass.
    for (const n of ["Mood", "M00d", "Modd", "Colle", "Coole", "Hoost", "Twittch", "Officiall"]) {
      expect(checkName(n).ok).toBe(true);
    }
  });

  test("a role or platform word refuses a name as any whole word of it; a person's name only as the whole name (#106)", () => {
    const refused = ["Mod Squad", "Squad Mod", "The Mod", "M0d Squad", "Mod2 Squad", "m o d squad", "Official Bob", "Bob_Official", "xX_admin_Xx", "Addmin Bob", "Big Moderator",
      "Host 2 Go", "Your Host", "Lead Streamer", "YouTube Fan", "Twitch-Kid", "Tw1tch Kid", "Al Mod", "Ghost Host",
      "OfficialBob", "TwitchKid", "AdminBob", "ModSquad", "HostBob", "McHost", "YouTubeFan", "You Tube Fan"];
    expect(refused.filter((n) => checkName(n).ok)).toEqual([]);
    for (const n of refused) expect(checkName(n)).toEqual({ ok: false, reason: "reserved" });
    const plays = ["Cole Smith", "Smith Cole", "Cole Porter", "Archon Fan", "Modern", "Modern Art", "Hostage", "Ghost", "Admiral", "Admins Team", "Twitcher", "YouTuber",
      "Streamers Fan", "Moody Bob", "Hosta Lily", "HostaLily", "TwitchyTom", "ModernArt", "AdmiralAckbar", "ColeSmith", "Mo Dern", "Tom Odd"];
    expect(plays.filter((n) => !checkName(n).ok)).toEqual([]);
    // Every word entry is a reserved entry, and no person's or factory name is one.
    expect(RESERVED_WORDS.filter((w) => !RESERVED_NAMES.includes(w) && !RESERVED_EXACT.includes(w))).toEqual([]);
    expect(RESERVED_WORDS.filter((w) => ["cole", "colemedin", "dynamous", "archon"].includes(w))).toEqual([]);
  });

  test("the boards show a stored name only if the lists allow it, whatever its length", () => {
    expect(isShownName("Alice")).toBe(true);
    expect(isShownName("A")).toBe(true); // too short to pick now, but the lists don't refuse it
    expect(isShownName("fuuuck")).toBe(false);
    expect(isShownName("admin")).toBe(false);
    expect(isShownName("  Cole   Medin ")).toBe(false);
  });

  test("the lists: lowercase a to z, no duplicates, a few hundred blocked words, nothing redundant", () => {
    for (const list of [BLOCKED_ANYWHERE, BLOCKED_WHOLE, EXCEPTIONS, RESERVED_NAMES, RESERVED_EXACT, RESERVED_WORDS]) {
      expect(list.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(BLOCKED_ANYWHERE.length + BLOCKED_WHOLE.length).toBeGreaterThanOrEqual(250);
    // No entry is already caught by another, so the count is real words, not padding.
    const anywhere = BLOCKED_ANYWHERE.map((w) => [w, new RegExp(entryPattern(w))] as const);
    const redundant = [...BLOCKED_ANYWHERE, ...BLOCKED_WHOLE].filter((w) => anywhere.some(([o, re]) => o !== w && re.test(w)));
    expect(redundant).toEqual([]);
    // No exception contains another: the shorter one already lets the longer word through, so
    // the longer one would only add places for a blocked word to hide.
    expect(EXCEPTIONS.filter((e) => EXCEPTIONS.some((o) => o !== e && e.includes(o)))).toEqual([]);
    // No exception is itself a whole-word block or a reserved name.
    expect(EXCEPTIONS.filter((w) => w.length <= 16 && !checkName(w).ok)).toEqual([]);
  });

  test("every exception that can hide a blocked word is named in blocked-words.ts's list of accepted leaks", () => {
    // Derived, so the documented list is complete by construction: an exception that holds a
    // blocked word, or shares three or more letters with the start or end of one, lets that
    // word through when the exception is written around it.
    const leaky = EXCEPTIONS.filter((e) =>
      BLOCKED_ANYWHERE.some((w) => {
        if (new RegExp(entryPattern(w)).test(e)) return true;
        for (let k = 3; k < Math.min(e.length, w.length); k++) {
          if (e.endsWith(w.slice(0, k)) || e.startsWith(w.slice(w.length - k))) return true;
        }
        return false;
      }),
    );
    expect(leaky.length).toBeGreaterThan(0);
    const header = readFileSync(join(import.meta.dir, "blocked-words.ts"), "utf8");
    const from = header.indexOf("Accepted exception leaks.");
    const to = header.indexOf("Two shared letters are not listed");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const listed = header.slice(from, to);
    expect(leaky.filter((e) => !new RegExp(`\\b${e}\\b`).test(listed))).toEqual([]);
  });
});

describe("teams", () => {
  test("only the listed teams are teams", () => {
    for (const t of TEAMS) expect(isTeam(t)).toBe(true);
    for (const v of ["Tabs", "SPACES", "", "tab", 1, null, undefined]) expect(isTeam(v)).toBe(false);
  });
});

describe("bot names", () => {
  test("a name whose first word reads 'bot' is kept for the server's bots, whatever the spelling", () => {
    const bots = ["bot alice", "Bot  Bob", "  BOT x", "bot 7", "bot", "Bot", "B0T", "8ot", "b0t x", "bot_x", "bot-x", "b o t", "bo t", "1 bot", "Bot 4455", "Bot2", "bot99", "BotAda", "BotX"];
    expect(bots.filter((n) => !isBotName(n))).toEqual([]);
    const people = ["bots-01", "robot x", "abbot y", "Robo", "Robot", "Abbot", "Boot", "Bottle", "Bots", "Abbot Bot", "RoBot", "BoTanya", "--", "__"];
    expect(people.filter((n) => isBotName(n))).toEqual([]);
  });

  test("the server's fill-bot names are all bot names, and all different", () => {
    for (const name of FILL_BOT_NAMES) expect(isBotName(name)).toBe(true);
    expect(new Set(FILL_BOT_NAMES).size).toBe(FILL_BOT_NAMES.length);
  });

  test("the bots script's names pass the name rules and are not bot names", () => {
    for (let i = 1; i <= 200; i++) {
      const name = `bots-${String(i).padStart(2, "0")}`;
      expect(checkName(name)).toEqual({ ok: true, name });
      expect(isBotName(name)).toBe(false);
    }
  });
});
