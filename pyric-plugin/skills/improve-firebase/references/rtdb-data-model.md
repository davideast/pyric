# RTDB Data Modeling

RTDB is one JSON tree; every path is an API endpoint and reading a path
downloads everything below it. Structure determines security, performance,
pagination, and query shape — so design paths around the reads.

## Steps

1. **Inventory the reads.** For each screen or listener: which entities, what
   order, what filters, how many items. Complete when every read is listed
   with its expected payload size.

2. **Survey existing data** (when a database exists). `database_data.crawl`
   maps the tree; `database_data.get` samples nodes. Complete when current shape and
   sizes are known.

3. **Design paths around the reads.** Defaults that work:
   - Top-level flat entity collections (`/users`, `/posts`, `/postSummaries`)
     — never nest one entity type inside another.
   - Index tables for reverse lookups (`/userGroups/$uid/$groupId: true`).
   - Denormalized summary nodes sized for list screens; detail nodes fetched
     per item.
   - Push IDs for append-only lists (chronologically sortable, no collisions).

   Complete when every inventoried read is served by one path whose full
   payload is what the screen needs.

4. **Plan writes for duplicated data.** Every denormalized copy gets a
   multi-path fan-out write — a single `database_data.update` with several full paths
   as keys updates all copies atomically. Complete when each duplicated field
   lists the paths one logical write touches.

5. **Declare query indexes.** Add `.indexOn` in the security rules for every
   child key used with `orderByChild`. Complete when each ordered/filtered
   read has a matching `.indexOn`.

6. **State the rules implications.** Flat top-level collections let each
   entity type carry its own access rule; index tables let membership gate
   reads. Hand the path map to the rules work (see the `rtdb-security-rules`
   skill). Complete when each path names who may read/write it.

7. **Seed and prove.** Write representative data with `database_data.set` /
   `database_data.push` / `database_data.update`, then read each inventoried path with
   `database_data.get` and confirm the payload matches step 1. Complete when reads
   return exactly the modeled shape.

## Reference — anti-patterns

- Deep nesting under users or entities — one read drags the subtree.
- God nodes every client reads — fan-out hot spot and privacy hazard.
- Arrays with sequential numeric keys — concurrent writers collide; use push
  IDs.
- SQL-style normalization requiring client-side joins — duplicate instead.
- Multi-field filtering with no query-shaped path — RTDB queries take one
  `orderBy`; precompute composite keys (`"lang_level": "en_5"`) or restructure.
