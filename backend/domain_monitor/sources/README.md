# Manual import directory

`imported.txt` backs the **Manual Import** source. It is written by the
dashboard's Import dialog and by `import_domains()`, and read back by
`ManualFileSource` so a scheduled scan can reproduce the same candidate set.

It ships **empty on purpose**. An empty file means the Manual Import source
reports itself *Not Configured* — nothing is discovered until you actually
import something.

- Format: one domain per line, or the first column of a CSV. `#` and `;` start
  a comment.
- Every line is normalised and validated before storage; URLs, `www.`
  prefixes, ports, paths and userinfo are stripped, and anything that is not a
  hostname is rejected.

## Other sources

Manual import is one adapter among several. Configure the rest with
environment variables — see the SEO Domain Radar section of the root README:

| Variable | Purpose |
| --- | --- |
| `DOMAIN_SOURCES` | Which adapters to enable, e.g. `manual,zone,feed` |
| `ZONE_FILE_DIRECTORY` | Directory of `.zone` / `.txt` / `.csv` / `.gz` files |
| `DOMAIN_FEED_URL` | HTTP feed that permits automated retrieval |
| `DOMAIN_USE_DEMO_DATA` | `true` loads `../fixtures/demo_domains.txt` (dev only) |

There is no `sources.json` any more; configuration is environment-driven so
nothing production-specific is committed.
