# Catalog qualification catalog-2026-10-12T18-19-57-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| emby | pass | healthy after 50s; page title "9382df6e54bf"; health 302; removed after the check; volumes and folders retained |
| emby (external storage) | pass | healthy after 31s; page title "93b9d7a53473"; health 302; external storage: --storage downloads=/mnt/harbor-test-storage/emby-downloads-q1819 mounted as bind; removed after the check; volumes and folders retained |
| jackett | pass | healthy after 40s; page title "Jackett"; health 301; removed after the check; volumes and folders retained |
| jackett (external storage) | pass | healthy after 30s; page title "Jackett"; health 301; external storage: --storage downloads=/mnt/harbor-test-storage/jackett-downloads-q1819 mounted as bind; removed after the check; volumes and folders retained |
| networkingtoolbox | pass | healthy after 21s; page title "Networking Toolbox"; health 200; removed after the check; volumes and folders retained |
| paperless | pass | healthy after 181s; page title "Paperless-ngx sign in"; health 302; removed after the check; volumes and folders retained |
| paperless (external storage) | pass | healthy after 107s; page title "Paperless-ngx sign in"; health 302; external storage: --storage paperless-export=/mnt/harbor-test-storage/paperless-paperless-export-q1819 --storage paperless-consume=/mnt/harbor-test-storage/paperless-paperless-consume-q1819 mounted as bind; removed after the check; volumes and folders retained |
| pingvin-share | pass | healthy after 62s; page title "Home - Pingvin Share"; health 200; removed after the check; volumes and folders retained |
| super-productivity | pass | healthy after 32s; page title "Super Productivity"; health 200; removed after the check; volumes and folders retained |
| wikijs | pass | healthy after 49s; page title "Wiki.js Setup"; health 200; removed after the check; volumes and folders retained |
