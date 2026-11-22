import { expect, test } from "bun:test";
import { ERROR_CODES } from "../../shared/arena/protocol";
import { SERVER_SILENT_MS, isFinalError, reconnectDelay, serverSilent, socketUrl } from "./net";

test("rejoin waits 0.5 s, doubling to 5 s", () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
});

test("a refused name, team or version never retries; a hello timeout does", () => {
  expect(ERROR_CODES.filter(isFinalError)).toEqual(["version", "name", "team"]);
});

test("the socket follows the page's scheme and host", () => {
  expect(socketUrl({ protocol: "https:", host: "bugs.example:8443" })).toBe("wss://bugs.example:8443/ws");
  expect(socketUrl({ protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/ws");
});

test("a connection silent for over 5 s is given up on (the server sends 20 snapshots a second)", () => {
  expect(serverSilent(1000, 1000 + SERVER_SILENT_MS)).toBe(false);
  expect(serverSilent(1000, 1001 + SERVER_SILENT_MS)).toBe(true);
});
