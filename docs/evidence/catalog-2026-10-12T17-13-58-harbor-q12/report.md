# Catalog qualification catalog-2026-10-12T17-13-58-harbor-q12

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| duplicati | pass | healthy after 46s; page title "Duplicati ngclient"; health 200; removed after the check; volumes and folders retained |
| duplicati (external storage) | fail | harbor install duplicati --name duplicati-q1713x --storage storage=/mnt/harbor-test-storage/duplicati-storage-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "duplicati does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| ghost | pass | healthy after 134s; page title "Ghost"; health 200; removed after the check; volumes and folders retained |
| homebox | pass | healthy after 34s; page title "HomeBox / Organize and Tag Your Stuff"; health 200; removed after the check; volumes and folders retained |
| mstream | pass | healthy after 69s; page title "mStream Music"; health 200; removed after the check; volumes and folders retained |
| mstream (external storage) | fail | harbor install mstream --name mstream-q1713x --storage downloads-music=/mnt/harbor-test-storage/mstream-downloads-music-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "mstream does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| picoclaw | pass | healthy after 32s; page title "PicoClaw"; health 302; removed after the check; volumes and folders retained |
| stirling-pdf | pass | healthy after 162s; page title "Stirling PDF"; health 200; removed after the check; volumes and folders retained |
| wavelog | pass | healthy after 52s; page title "Install / Wavelog"; health 302; removed after the check; volumes and folders retained |
| webcheck | pass | healthy after 71s; page title "Web Check"; health 302; removed after the check; volumes and folders retained |
