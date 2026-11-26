# Path clearance

Write one standalone boolean function named `pathClear(board, x, y, dx, dy)` in your assigned Pyric syntax. The board is a full map of square names a1 through h8 to strings. An empty string means the square is empty. Coordinates are zero based, with a1 at (0, 0). The source is (x, y), and the destination is (x + dx, y + dy). Both are on the board. The displacement is a valid nonzero horizontal, vertical or diagonal line, at most seven steps long.

Return true exactly when every square strictly between the source and destination is empty. Endpoint pieces are irrelevant. Your deliverable is the authored function, with no TypeScript adapter. Use the traversal idiom on your syntax card.

Work in the supplied directory. Use only this brief, your syntax card, and the public compiler via `bun public.mjs FILENAME`. You may make your own inputs. Save your first complete attempt as `first.policy` before testing or revising it. Keep that file. Save the submission as `locked.policy` and report the two SHA-256 hashes. Both authors have a 15-minute cap and may lock early. The same hidden suite will be run after both submissions lock.
