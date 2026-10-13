# Catalog qualification catalog-2026-10-12T17-13-14-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| ersatztv-legacy | pass | healthy after 70s; page title "ErsatzTV Legacy"; health 200; removed after the check; volumes and folders retained |
| ersatztv-legacy (external storage) | fail | harbor install ersatztv-legacy --name ersatztv-legacy-q1713x --storage downloads=/mnt/harbor-test-storage/ersatztv-legacy-downloads-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "ersatztv-legacy does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| kiwix | pass | healthy after 24s; page title "Welcome to Kiwix Server"; health 200; removed after the check; volumes and folders retained |
| kiwix (external storage) | fail | harbor install kiwix --name kiwix-q1713x --storage downloads=/mnt/harbor-test-storage/kiwix-downloads-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "kiwix does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| nutstash-wallet | pass | healthy after 43s; page title ""; health 200; removed after the check; volumes and folders retained |
| paperless | pass | healthy after 191s; page title "Paperless-ngx sign in"; health 302; removed after the check; volumes and folders retained |
| paperless (external storage) | fail | harbor install paperless --name paperless-q1713x --storage paperless-export=/mnt/harbor-test-storage/paperless-paperless-export-q1713 --storage paperless-consume=/mnt/harbor-test-storage/paperless-paperless-consume-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "paperless does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| remmina | pass | healthy after 93s; page title "Remmina"; health 200; removed after the check; volumes and folders retained |
| tautulli | pass | healthy after 37s; page title "Tautulli - Welcome /"; health 303; removed after the check; volumes and folders retained |
| wizarr | pass | healthy after 58s; page title "Setup Wizarr - None"; health 302; removed after the check; volumes and folders retained |
