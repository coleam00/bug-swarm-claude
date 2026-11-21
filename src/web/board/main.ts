// The /board page for the stream: no input, only what the server last returned
// (engineering.md, "UI state follows the server").
import { boardView, joinHost, type Board } from "./data";
import { createPoller, fetchBoard } from "./poll";
import { createBoardDom } from "./view";

const root = document.getElementById("board");
if (!root) throw new Error("board: #board is missing from board.html");

const dom = createBoardDom(root, joinHost(location.origin));
let prev: Board | null = null;

createPoller({
  load: () => fetchBoard(),
  onData: (board) => {
    dom.render(boardView(prev, board));
    prev = board;
  },
  onStatus: dom.setStatus,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}).start();
