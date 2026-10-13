# Catalog qualification catalog-2026-10-12T17-01-30-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| grafana | fail | health probe http://localhost:18080/: 302, 302, 302, 302, 302, 302 (expected 200); container logs:  |
| wordpress | fail | health probe http://localhost:18081/: 302, 302, 302, 302, 302, 302 (expected 200); container logs:  |
