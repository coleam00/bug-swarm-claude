import { describe, expect, test } from "bun:test";
import { listenConfig } from "./listen";

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
