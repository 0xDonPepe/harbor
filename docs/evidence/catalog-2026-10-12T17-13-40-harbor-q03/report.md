# Catalog qualification catalog-2026-10-12T17-13-40-harbor-q03

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| bark-wallet | pass | healthy after 61s; page title "Bark Wallet"; health 200; removed after the check; volumes and folders retained |
| bazarr | pass | healthy after 75s; page title "General - Bazarr (Settings)"; health 200; removed after the check; volumes and folders retained |
| bazarr (external storage) | fail | harbor install bazarr --name bazarr-q1713x --storage downloads=/mnt/harbor-test-storage/bazarr-downloads-q1713 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "bazarr does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| cashu-me | pass | healthy after 36s; page title "Cashu.me"; health 200; removed after the check; volumes and folders retained |
| flatnotes | pass | healthy after 96s; page title "flatnotes"; health 200; removed after the check; volumes and folders retained |
| leafwiki | pass | healthy after 32s; page title "Login - LeafWiki"; health 200; removed after the check; volumes and folders retained |
| omnitools | pass | healthy after 35s; page title "OmniTools"; health 200; removed after the check; volumes and folders retained |
| satoshi-dashboard | pass | healthy after 48s; page title "Bitcoin Dashboard - Live BTC Price, Market Cap & Network Stats"; health 200; removed after the check; volumes and folders retained |
| thinkdashboard | pass | healthy after 28s; page title "Dashboard"; health 200; removed after the check; volumes and folders retained |
| zen | pass | healthy after 26s; page title "Zen"; health 200; removed after the check; volumes and folders retained |
