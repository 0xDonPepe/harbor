# Catalog qualification catalog-2026-10-12T17-14-01-harbor-q15

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| baikal | pass | healthy after 29s; page title "Baïkal Maintenance"; health 302; removed after the check; volumes and folders retained |
| btctracker | pass | healthy after 51s; page title "BTC Tracker"; health 307; removed after the check; volumes and folders retained |
| enclosed | pass | healthy after 43s; page title "Enclosed - Send private and secure notes"; health 200; removed after the check; volumes and folders retained |
| invio | pass | healthy after 71s; page title "Invio"; health 303; removed after the check; volumes and folders retained |
| jotty | pass | healthy after 45s; page title "jotty·page"; health 307; removed after the check; volumes and folders retained |
| notediscovery | pass | healthy after 31s; page title "NoteDiscovery"; health 200; removed after the check; volumes and folders retained |
| pyload-ng | pass | healthy after 39s; page title "Login - pyLoad"; health 302; removed after the check; volumes and folders retained |
| pyload-ng (external storage) | fail | harbor install pyload-ng --name pyload-ng-q1714x --storage downloads=/mnt/harbor-test-storage/pyload-ng-downloads-q1714 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "pyload-ng does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| swingmusic | pass | healthy after 43s; page title "Swing Music"; health 200; removed after the check; volumes and folders retained |
| swingmusic (external storage) | fail | harbor install swingmusic --name swingmusic-q1714x --storage downloads=/mnt/harbor-test-storage/swingmusic-downloads-q1714 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "swingmusic does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| wingfit | pass | healthy after 29s; page title "Wingfit - Authentication"; health 200; removed after the check; volumes and folders retained |
