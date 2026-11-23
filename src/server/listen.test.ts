import { describe, expect, test } from "bun:test";
import { dataDirFrom, listenConfig } from "./listen";

describe("listenConfig", () => {
  test("defaults to localhost on 3000", () => {
    expect(listenConfig({})).toEqual({ port: 3000, hostname: "127.0.0.1" });
  });

  test("honours PORT", () => {
    expect(listenConfig({ PORT: "4321" })).toEqual({ port: 4321, hostname: "127.0.0.1" });
  });

  test("production listens on all interfaces", () => {
    expect(listenConfig({ NODE_ENV: "production" })).toEqual({ port: 3000, hostname: "0.0.0.0" });
    expect(listenConfig({ NODE_ENV: "production", PORT: "8080" })).toEqual({ port: 8080, hostname: "0.0.0.0" });
  });

  test("development and test stay on localhost", () => {
    expect(listenConfig({ NODE_ENV: "development" }).hostname).toBe("127.0.0.1");
    expect(listenConfig({ NODE_ENV: "test" }).hostname).toBe("127.0.0.1");
  });
});

describe("dataDirFrom", () => {
  test("production refuses to start without an explicit DATA_DIR", () => {
    for (const DATA_DIR of [undefined, "", "   "]) {
      const r = dataDirFrom({ NODE_ENV: "production", DATA_DIR });
      expect("error" in r && r.error).toStartWith("DATA_DIR is not set: in production the server refuses to start");
    }
  });

  test("production uses the DATA_DIR it is given", () => {
    expect(dataDirFrom({ NODE_ENV: "production", DATA_DIR: " /data " })).toEqual({ dataDir: "/data" });
  });

  test("outside production it defaults to data/", () => {
    expect(dataDirFrom({})).toEqual({ dataDir: "data" });
    expect(dataDirFrom({ NODE_ENV: "test", DATA_DIR: "" })).toEqual({ dataDir: "data" });
    expect(dataDirFrom({ DATA_DIR: "scratch" })).toEqual({ dataDir: "scratch" });
  });
});
