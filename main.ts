// Sokoban solver, push-optimal room by room.
//
// A level is a hallway with one to four rooms off it; a box pushed out of its
// room can never come back, so each room is solved on its own and the rooms'
// push counts add up to the level's optimum. Each room is searched with A*
// over pushes (a state is the boxes plus the player's reachable region), with
// an exact box-to-goal matching heuristic and two deadlock prunes: a box on a
// dead square (no pull-back path to any goal) and a frozen 2x2 block. The
// search budget is counted in states, never in wall-clock time, so two runs
// of the program write the same bytes.
//
// Usage: node main.ts (reads $MAKEFUN_INPUT_DIR, default /input; writes
// $MAKEFUN_OUTPUT_DIR, default /output). One solution.txt per instance.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// up, down, left, right: step deltas, walk letters, push letters.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const WALK = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

// Work budgets, counted in states: deterministic across runs.
const MAX_STATES = 250_000;
const MAX_TOTAL_STATES = 4_000_000;
let totalStates = 0;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Solution = { pushes: number; moves: string };

/** Parse XSB: '#' wall, ' ' floor, '.' goal, '$' box, '*' box on goal, '@' player, '+' player on goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can still be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const n = wall.length;
  const live = new Uint8Array(n);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const y = x - d;
      if (y < 0 || y >= n) continue;
      const z = y - d;
      if (z < 0 || z >= n) continue;
      if (wall[y] === 0 && wall[z] === 0 && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Flood fill from `from` over open floor (walls and `occ` in the way); returns the region's lowest square. */
function flood(
  w: number,
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const px = p % w;
    for (let k = 0; k < 4; k++) {
      if (k === 2 && px === 0) continue;
      if (k === 3 && px === w - 1) continue;
      const q = p + DY[k]! * w + DX[k]!;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenAt(
  w: number,
  h: number,
  wall: Uint8Array,
  occ: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const corners = [t, t - 1, t - w, t - w - 1];
  for (const c of corners) {
    const cx = c % w;
    const cy = Math.floor(c / w);
    if (cx < 0 || cx > w - 2 || cy < 0 || cy > h - 2) continue;
    const a = c;
    const b = c + 1;
    const d = c + w;
    const e = c + w + 1;
    if (!((wall[a]! || occ[a]!) && (wall[b]! || occ[b]!) && (wall[d]! || occ[d]!) && (wall[e]! || occ[e]!))) continue;
    if ((occ[a]! && !goal[a]!) || (occ[b]! && !goal[b]!) || (occ[d]! && !goal[d]!) || (occ[e]! && !goal[e]!)) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(w: number, wall: Uint8Array, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const n = wall.length;
  const prev = new Int32Array(n).fill(-1);
  const how = new Array<string>(n);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    const px = p % w;
    for (let k = 0; k < 4; k++) {
      if (k === 2 && px === 0) continue;
      if (k === 3 && px === w - 1) continue;
      const q = p + DY[k]! * w + DX[k]!;
      if (q < 0 || q >= n || wall[q] !== 0 || occ[q] !== 0 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = WALK[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** All permutations of 0..n-1. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}

/** BFS distances from each goal over open floor, ignoring boxes (-1: unreachable). */
function goalDistances(w: number, wall: Uint8Array, goals: number[]): Int32Array[] {
  const n = wall.length;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(n).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      const px = p % w;
      for (let k = 0; k < 4; k++) {
        if (k === 2 && px === 0) continue;
        if (k === 3 && px === w - 1) continue;
        const q = p + DY[k]! * w + DX[k]!;
        if (q < 0 || q >= n || wall[q] !== 0 || dist[q] !== -1) continue;
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
    out.push(dist);
  }
  return out;
}

type HeapEntry = [number, number, number, number]; // [f, h, seq, state]

function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      [heap[i], heap[c]] = [heap[c]!, heap[i]!];
      i = c;
    }
  }
  return top;
}

/**
 * Push-optimal (astar/bfs) or first-found (greedy) solution of `board`, searching at most
 * `maxStates` states: {pushes, moves}, or null when the search gives up. A state is the boxes'
 * squares and the player's reachable region (named by its lowest square); the search expands
 * states in order of pushes made (astar: pushes plus the matching heuristic, which never
 * overestimates: one push moves one box one square), so the first solved state it meets in
 * astar/bfs mode is push-optimal.
 */
function searchPushes(
  board: Board,
  mode: 'astar' | 'bfs' | 'greedy',
  maxStates: number,
): Solution | null {
  const { w, h, wall, goals, boxes, player } = board;
  const n = wall.length;
  const nb = boxes.length;
  const goal = new Uint8Array(n);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of boxes) if (!live[b]) return null;
  const dists = goalDistances(w, wall, goals);
  const match = nb <= 6 && goals.length === nb ? permutations(nb) : null;
  const heuristic = (bs: number[]): number => {
    if (match) {
      let best = Infinity;
      for (const p of match) {
        let s = 0;
        for (let i = 0; i < nb; i++) {
          const d = dists[p[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (const dt of dists) {
        const d = dt[b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  const size = n;
  const numericKey = nb <= 5 && Math.pow(size, nb + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return low + ':' + bs.join(',');
  };

  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  const h0 = heuristic(boxes);
  if (h0 === Infinity) return null;
  if (solved(boxes)) return { pushes: 0, moves: '' };

  // The states in the order found: their boxes, the player's square, the push that made them.
  const stBoxes: number[][] = [boxes.slice()];
  const stPlayer: number[] = [player];
  const stParent: number[] = [-1];
  const stPushBox: number[] = [-1];
  const stPushDir: number[] = [-1];
  const stG: number[] = [0];
  const stKey: (number | string)[] = [];
  const occ = new Uint8Array(n);
  for (const b of boxes) occ[b] = 1;
  const seen = new Int32Array(n);
  const mark = new Int32Array(n);
  const stack = new Int32Array(n);
  let stamp = 0;
  const low0 = flood(w, wall, occ, player, seen, ++stamp, stack);
  for (const b of boxes) occ[b] = 0;
  stKey.push(keyOf(boxes, low0));
  const best = new Map<number | string, number>([[stKey[0]!, 0]]);
  const visited = new Set<number | string>([stKey[0]!]);
  const heap: HeapEntry[] = [[mode === 'bfs' ? 0 : h0, h0, 0, 0]];
  let seq = 1;
  let generated = 1;

  const reconstruct = (s: number): Solution => {
    const chain: number[] = [];
    for (let t = s; t > 0; t = stParent[t]!) chain.push(t);
    chain.reverse();
    let moves = '';
    let curPlayer = player;
    let cur = boxes.slice();
    const occ2 = new Uint8Array(n);
    for (const t of chain) {
      const from = stPushBox[t]!;
      const k = stPushDir[t]!;
      const d = DY[k]! * w + DX[k]!;
      for (const x of cur) occ2[x] = 1;
      moves += walkTo(w, wall, occ2, curPlayer, from - d);
      for (const x of cur) occ2[x] = 0;
      moves += PUSH[k]!;
      curPlayer = from;
      cur[cur.indexOf(from)] = from + d;
      cur.sort((a, b) => a - b);
    }
    return { pushes: chain.length, moves };
  };

  while (heap.length > 0) {
    const [, , , s] = heapPop(heap);
    const g = stG[s]!;
    if (mode !== 'greedy' && best.get(stKey[s]!) !== g) continue;
    const bs = stBoxes[s]!;
    if (solved(bs)) return reconstruct(s);
    for (const b of bs) occ[b] = 1;
    const regionStamp = ++stamp;
    flood(w, wall, occ, stPlayer[s]!, seen, regionStamp, stack);
    for (let bi = 0; bi < nb; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      for (let k = 0; k < 4; k++) {
        if (k === 2 && bx === 0) continue;
        if (k === 3 && bx === w - 1) continue;
        const d = DY[k]! * w + DX[k]!;
        const sq = b - d;
        const t = b + d;
        if (t < 0 || t >= n || sq < 0 || sq >= n) continue;
        if (seen[sq] !== regionStamp) continue;
        if (wall[t] !== 0 || occ[t] !== 0 || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        if (frozenAt(w, h, wall, occ, goal, t)) {
          occ[t] = 0;
          occ[b] = 1;
          continue;
        }
        const next = bs.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const low = flood(w, wall, occ, b, mark, ++stamp, stack);
        const key = keyOf(next, low);
        occ[t] = 0;
        occ[b] = 1;
        const g2 = g + 1;
        if (mode === 'greedy') {
          if (visited.has(key)) continue;
        } else {
          const prev = best.get(key);
          if (prev !== undefined && prev <= g2) continue;
        }
        const h2 = heuristic(next);
        if (h2 === Infinity) continue;
        if (generated >= maxStates || totalStates >= MAX_TOTAL_STATES) return null;
        generated++;
        totalStates++;
        if (mode === 'greedy') visited.add(key);
        else best.set(key, g2);
        const idx = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stPushBox.push(b);
        stPushDir.push(k);
        stG.push(g2);
        stKey.push(key);
        const f2 = mode === 'bfs' ? g2 : mode === 'greedy' ? h2 : g2 + h2;
        heapPush(heap, [f2, h2, seq++, idx]);
      }
    }
    for (const b of bs) occ[b] = 0;
  }
  return null;
}

type Room = { boxes: number[]; goals: number[] };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there
 * reaches no goal) out of the floor, and each part left that holds a box is a room.
 * Null when some part holds more or fewer boxes than goals, or a box starts in the hallway.
 */
function roomsOf(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const n = wall.length;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(n);
  for (let i = row * w; i < (row + 1) * w; i++) if (wall[i] === 0 && !live[i]) cut[i] = 1;
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(n).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (wall[s] !== 0 || cut[s] || part[s] >= 0) continue;
    const idx = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    part[s] = idx;
    stack.length = 0;
    stack.push(s);
    for (let i = 0; i < stack.length; i++) {
      const p = stack[i]!;
      const px = p % w;
      for (let k = 0; k < 4; k++) {
        if (k === 2 && px === 0) continue;
        if (k === 3 && px === w - 1) continue;
        const q = p + DY[k]! * w + DX[k]!;
        if (q < 0 || q >= n || wall[q] !== 0 || cut[q] || part[q] >= 0) continue;
        part[q] = idx;
        stack.push(q);
      }
    }
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One room's solution: A* first, then plain BFS, then a greedy first-found search. */
function solveRoom(sub: Board): Solution | null {
  return (
    searchPushes(sub, 'astar', MAX_STATES) ??
    searchPushes(sub, 'bfs', MAX_STATES) ??
    searchPushes(sub, 'greedy', MAX_STATES)
  );
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other rooms'
 * boxes standing as walls (on their goals once their room is done), the player walking on
 * from where the last room left it. A box never leaves its room, so the rooms' optima add
 * up to the level's.
 */
function solveByRooms(board: Board): Solution | null {
  const rooms = roomsOf(board);
  if (rooms === null) return null;
  let player = board.player;
  let pushes = 0;
  let moves = '';
  const done = new Array<boolean>(rooms.length).fill(false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall2 = board.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const x of done[oj] ? other.goals : other.boxes) wall2[x] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall: wall2,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(board.w, player, solved.moves);
    done[ri] = true;
  }
  return { pushes, moves };
}

/** Replay `moves` on the level (the checker's rules): the pushes it takes, or -1 when illegal or unsolved. */
function replayPushes(board: Board, moves: string): number {
  const { w, wall, goals, boxes, player } = board;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of boxes) box[b] = 1;
  let p = player;
  let pushes = 0;
  for (const ch of moves.replace(/\s+/g, '')) {
    const c = ch.toLowerCase();
    if (c !== 'u' && c !== 'd' && c !== 'l' && c !== 'r') return -1;
    const d = c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
    const next = p + d;
    if (next < 0 || next >= wall.length || wall[next] !== 0) return -1;
    if (box[next]) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] !== 0 || box[beyond]) return -1;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    p = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return -1;
  return pushes;
}

/** The level's moves: room by room, else a whole-level search, else no moves (still a valid answer). */
function solveLevel(text: string): string {
  try {
    const board = parseLevel(text);
    const byRooms = solveByRooms(board);
    if (byRooms !== null && replayPushes(board, byRooms.moves) === byRooms.pushes) return byRooms.moves;
    const whole =
      searchPushes(board, 'astar', MAX_STATES) ?? searchPushes(board, 'greedy', MAX_STATES);
    if (whole !== null && replayPushes(board, whole.moves) === whole.pushes) return whole.moves;
    return '';
  } catch {
    return '';
  }
}

for (const id of readdirSync(IN_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
