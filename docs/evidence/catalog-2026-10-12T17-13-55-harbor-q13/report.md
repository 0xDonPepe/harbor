# Catalog qualification catalog-2026-10-12T17-13-55-harbor-q13

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| element | pass | healthy after 38s; page title "Element"; health 200; removed after the check; volumes and folders retained |
| hortusfox | pass | healthy after 63s; page title "My workspace"; health 302; removed after the check; volumes and folders retained |
| influxdb2 | pass | healthy after 31s; page title "InfluxDB"; health 200; removed after the check; volumes and folders retained |
| myspeed | pass | healthy after 51s; page title "MySpeed"; health 200; removed after the check; volumes and folders retained |
| pinchflat | pass | healthy after 48s; page title "Pinchflat"; health 200; removed after the check; volumes and folders retained |
| pinchflat (external storage) | fail | harbor install pinchflat --name pinchflat-q1713x --storage downloads=/mnt/harbor-test-storage/pinchflat-downloads-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "pinchflat does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| strix | pass | healthy after 60s; page title "Strix - Camera Stream Discovery"; health 200; removed after the check; volumes and folders retained |
| whoogle-search | pass | healthy after 113s; page title "Whoogle Search"; health 200; removed after the check; volumes and folders retained |
| yamtrack | pass | healthy after 116s; page title "Login - Yamtrack"; health 302; removed after the check; volumes and folders retained |
