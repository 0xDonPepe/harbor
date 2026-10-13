# Catalog qualification catalog-2026-10-12T18-22-00-harbor-q14

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| duplicati | pass | healthy after 39s; page title "Duplicati ngclient"; health 200; removed after the check; volumes and folders retained |
| duplicati (external storage) | pass | healthy after 26s; page title "Duplicati ngclient"; health 200; external storage: --storage storage=/mnt/harbor-test-storage/duplicati-storage-q1822 mounted as bind; removed after the check; volumes and folders retained |
| homebox | pass | healthy after 24s; page title "HomeBox / Organize and Tag Your Stuff"; health 200; removed after the check; volumes and folders retained |
| influxdb | pass | healthy after 41s; page title "Chronograf"; health 200; removed after the check; volumes and folders retained |
| mstream | pass | healthy after 49s; page title "mStream Music"; health 200; removed after the check; volumes and folders retained |
| mstream (external storage) | pass | healthy after 26s; page title "mStream Music"; health 200; external storage: --storage downloads-music=/mnt/harbor-test-storage/mstream-downloads-music-q1822 mounted as bind; removed after the check; volumes and folders retained |
| picoclaw | pass | healthy after 26s; page title "PicoClaw"; health 302; removed after the check; volumes and folders retained |
| stirling-pdf | pass | healthy after 202s; page title "Stirling PDF"; health 200; removed after the check; volumes and folders retained |
| webcheck | pass | healthy after 50s; page title "Web Check"; health 302; removed after the check; volumes and folders retained |
| wordpress | pass | healthy after 52s; page title "WordPress › Installation"; health 302; removed after the check; volumes and folders retained |
