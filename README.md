# Sokoban Solver

A push-optimal Sokoban solver, built for make.fun's "Build the best Sokoban
solver, 21 November 2026" bounty ($100 in USDC).

`main.ts` answers every instance of a set in one run: it reads
`$MAKEFUN_INPUT_DIR/<id>/level.txt` (XSB) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt`, the player's moves in LURD.

## How it works

A level is a hallway with one to four rooms off it, and a box pushed out of
its room can never come back — so each room is solved on its own and the
rooms' push counts add up to the level's optimum. Each room is searched with
A* over pushes: a state is the boxes' squares plus the player's reachable
region (named by its lowest square), and the heuristic is the exact
minimum-cost matching of boxes to goals over box-ignoring distances, so the
first solved state found is push-optimal. Two deadlock prunes keep the search
small: dead squares (no pull-back path from the square to any goal) and
frozen 2x2 blocks of walls and boxes. The search budget is counted in states,
never in wall-clock time, so two runs write the same bytes.

If a room's search gives up, the solver retries with plain BFS over pushes,
then with a greedy first-found search; if the level is no set of rooms, it
searches the whole level instead. Every answer is replayed before it is
written, so an answer is never illegal; a level it cannot solve gets an empty
solution.

## Run it

```sh
# grade locally against the practice set (needs the competition kit)
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Or run the driver directly on a cases directory:

```sh
MAKEFUN_INPUT_DIR=<dir with i001/level.txt, ...> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## Practice set

On the kit's practice set the solver finds the push optimum on all five
instances (13, 16, 29, 47 and 60 pushes) for a practice score of 1,000,000.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vnsny7za&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
