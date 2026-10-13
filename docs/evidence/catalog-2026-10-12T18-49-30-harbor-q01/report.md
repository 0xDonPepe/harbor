# Catalog qualification catalog-2026-10-12T18-49-30-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| metube | pass | healthy after 24s; page title "MeTube"; health 200; removed after the check; volumes and folders retained |
| metube (external storage) | pass | healthy after 23s; page title "MeTube"; health 200; external storage: --storage downloads-metube=/mnt/harbor-test-storage/metube-downloads-metube-q1849 mounted as bind; removed after the check; volumes and folders retained |
