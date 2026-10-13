# Catalog qualification catalog-2026-10-12T17-13-39-harbor-q09

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| docuseal | pass | healthy after 61s; page title "DocuSeal / Open Source Document Signing"; health 302; removed after the check; volumes and folders retained |
| downtify | pass | healthy after 43s; page title "Downtify"; health 200; removed after the check; volumes and folders retained |
| downtify (external storage) | fail | harbor install downtify --name downtify-q1713x --storage downloads-downtify=/mnt/harbor-test-storage/downtify-downloads-downtify-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "downtify does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| heimdall | pass | healthy after 48s; page title "Heimdall"; health 200; removed after the check; volumes and folders retained |
| metube | pass | healthy after 43s; page title "MeTube"; health 200; removed after the check; volumes and folders retained |
| metube (external storage) | fail | harbor install metube --name metube-q1713x --storage downloads-metube=/mnt/harbor-test-storage/metube-downloads-metube-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "metube does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| passky-server | pass | healthy after 43s; page title "Passky"; health 200; removed after the check; volumes and folders retained |
| pastefy | pass | healthy after 56s; page title "Pastefy • Share your code snippets"; health 200; removed after the check; volumes and folders retained |
| spacebot | pass | healthy after 78s; page title "Spacebot"; health 200; removed after the check; volumes and folders retained |
| valorgrid | pass | healthy after 51s; page title "ValorGrid"; health 200; removed after the check; volumes and folders retained |
